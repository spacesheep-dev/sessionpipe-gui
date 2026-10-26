//! Rate limits per rp id (arch-identity §6.4). Over a limit the signer refuses and logs; it
//! never queues a signature.
//!
//! | operation | limit |
//! |---|---|
//! | grant (Touch ID) | ≤ 1 per 10 min, plus one immediate retry after a verifier refusal; ≤ 6 per day |
//! | confirm (Touch ID) | ≤ 20 per hour |
//! | pair (Touch ID) | ≤ 10 per hour |
//! | csig (day key, no prompt) | token bucket: 20 burst, 1 per second |
use std::collections::{HashMap, VecDeque};

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
const DAY: u64 = 24 * HOUR;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Op {
    Grant,
    Confirm,
    Pair,
}

#[derive(Debug, Default)]
struct Bucket {
    tokens: f64,
    at: u64,
}

#[derive(Debug, Default)]
struct PerRp {
    /// When each Touch ID of this kind was asked for, newest last (a day's worth).
    seen: HashMap<Op, VecDeque<u64>>,
    /// The one retry after a refusal: used since the last grant.
    retry_used: bool,
    csig: Option<Bucket>,
}

#[derive(Debug, Default)]
pub struct Limits {
    rps: HashMap<String, PerRp>,
}

pub const CSIG_BURST: f64 = 20.0;
pub const CSIG_PER_SEC: f64 = 1.0;

impl Limits {
    /// May a prompt of `op` go now? Records it when it may. `retry`: a grant asked for
    /// again because the verifier refused the last one.
    pub fn prompt(&mut self, rp: &str, op: Op, now: u64, retry: bool) -> Result<(), &'static str> {
        let r = self.rps.entry(rp.to_string()).or_default();
        let q = r.seen.entry(op).or_default();
        while q.front().is_some_and(|&t| now.saturating_sub(t) >= DAY) {
            q.pop_front();
        }
        let within = |q: &VecDeque<u64>, span: u64| {
            q.iter().filter(|&&t| now.saturating_sub(t) < span).count()
        };
        let ok = match op {
            Op::Grant => {
                if within(q, DAY) >= 6 {
                    false
                } else if within(q, 10 * MIN) == 0 {
                    true
                } else {
                    retry && !r.retry_used
                }
            }
            Op::Confirm => within(q, HOUR) < 20,
            Op::Pair => within(q, HOUR) < 10,
        };
        if !ok {
            log::warn!("identity: {op:?} for {rp} refused by its rate limit");
            return Err("rate_limited");
        }
        if op == Op::Grant {
            r.retry_used = retry && within(q, 10 * MIN) > 0;
        }
        q.push_back(now);
        Ok(())
    }

    /// One day-key signature (no prompt): the token bucket.
    pub fn csig(&mut self, rp: &str, now: u64) -> Result<(), &'static str> {
        let r = self.rps.entry(rp.to_string()).or_default();
        let b = r.csig.get_or_insert(Bucket {
            tokens: CSIG_BURST,
            at: now,
        });
        let refill = now.saturating_sub(b.at) as f64 / 1000.0 * CSIG_PER_SEC;
        b.tokens = (b.tokens + refill).min(CSIG_BURST);
        b.at = now;
        if b.tokens < 1.0 {
            log::warn!("identity: csig for {rp} refused by its rate limit");
            return Err("rate_limited");
        }
        b.tokens -= 1.0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const T: u64 = 1_790_800_000_000;

    #[test]
    fn grants_one_per_ten_minutes_one_retry_six_a_day() {
        let mut l = Limits::default();
        assert!(l.prompt("rp", Op::Grant, T, false).is_ok());
        assert_eq!(
            l.prompt("rp", Op::Grant, T + MIN, false),
            Err("rate_limited")
        );
        // The verifier refused it: one immediate retry, not two.
        assert!(l.prompt("rp", Op::Grant, T + MIN, true).is_ok());
        assert!(l.prompt("rp", Op::Grant, T + 2 * MIN, true).is_err());
        // Another rp id has its own budget.
        assert!(l.prompt("other", Op::Grant, T + 2 * MIN, false).is_ok());
        // Ten minutes on, a grant is fine again, and the retry is available again.
        let mut t = T + 11 * MIN;
        assert!(l.prompt("rp", Op::Grant, t, false).is_ok()); // 3rd today
        t += 11 * MIN;
        assert!(l.prompt("rp", Op::Grant, t, false).is_ok()); // 4th
        t += 11 * MIN;
        assert!(l.prompt("rp", Op::Grant, t, false).is_ok()); // 5th
        t += 11 * MIN;
        assert!(l.prompt("rp", Op::Grant, t, false).is_ok()); // 6th
        t += 11 * MIN;
        assert!(l.prompt("rp", Op::Grant, t, false).is_err()); // a 7th in a day
        assert!(l.prompt("rp", Op::Grant, t, true).is_err());
        // A day after the first, the window has moved.
        assert!(l.prompt("rp", Op::Grant, T + DAY + MIN, false).is_ok());
    }

    #[test]
    fn confirms_twenty_an_hour_pairs_ten() {
        let mut l = Limits::default();
        for i in 0..20 {
            assert!(l.prompt("rp", Op::Confirm, T + i, false).is_ok());
        }
        assert!(l.prompt("rp", Op::Confirm, T + 30, false).is_err());
        assert!(l.prompt("rp", Op::Confirm, T + HOUR, false).is_ok());
        for i in 0..10 {
            assert!(l.prompt("rp", Op::Pair, T + i, false).is_ok());
        }
        assert!(l.prompt("rp", Op::Pair, T + 10, false).is_err());
    }

    #[test]
    fn csig_bucket_twenty_burst_one_a_second() {
        let mut l = Limits::default();
        for _ in 0..20 {
            assert!(l.csig("rp", T).is_ok());
        }
        assert_eq!(l.csig("rp", T), Err("rate_limited"));
        assert!(l.csig("rp", T + 999).is_err());
        assert!(l.csig("rp", T + 1000).is_ok());
        assert!(l.csig("rp", T + 1000).is_err());
        // A long pause refills to the burst, never past it.
        for _ in 0..20 {
            assert!(l.csig("rp", T + 3_600_000).is_ok());
        }
        assert!(l.csig("rp", T + 3_600_000).is_err());
    }
}
