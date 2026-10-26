//! The needs-you counter over a stream recorded from the demo receiver on 7811
//! (`x-sessionpipe-client: shell`, 70 s, frames slimmed to the fields the shell reads).

use sp_receivers::needs::NeedsYou;
use sp_receivers::sse::{SseItem, SseParser};

#[test]
fn needs_you_over_a_recorded_demo_stream() {
    let raw = include_bytes!("fixtures/stream-7811.sse");
    let mut p = SseParser::new();
    let mut n = NeedsYou::new("rx");
    let mut seq = vec![];
    let mut opened = vec![];
    let mut kinds = std::collections::BTreeMap::<String, usize>::new();
    // Fed in odd-sized chunks, as a socket would.
    for chunk in raw.chunks(997) {
        for item in p.push(chunk) {
            let SseItem::Event { event, data, .. } = item else {
                continue;
            };
            *kinds.entry(event).or_default() += 1;
            let c = n.apply_json(&data);
            opened.extend(c.opened);
            if seq.last() != Some(&n.count()) {
                seq.push(n.count());
            }
        }
    }
    assert_eq!(kinds.get("snapshot"), Some(&1));
    assert!(kinds.get("event").copied().unwrap_or(0) > 50, "{kinds:?}");
    // The same sequence an independent reading of the recording gives.
    assert_eq!(seq, vec![0, 1]);
    assert_eq!(opened.len(), 1, "one attention opened after the snapshot");
    let item = &n.items()[0];
    assert_eq!(item.attentions.len(), 1);
    assert!(!item.display_title().is_empty());
}
