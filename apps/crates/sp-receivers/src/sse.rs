//! A server-sent events parser (the WHATWG event-stream format), byte-fed so it works on
//! whatever chunks the network hands us.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// A dispatched event. `event` is "message" when the stream named none.
    Event {
        event: String,
        data: String,
        id: Option<String>,
    },
    /// A comment line (`: ping`). Proves the connection is alive.
    Comment(String),
    /// A `retry:` field: the server's reconnection time.
    Retry(u64),
}

#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    /// The previous chunk ended on `\r`: a following `\n` belongs to the same line end.
    after_cr: bool,
    event: Option<String>,
    data: Option<String>,
    id: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseItem> {
        let mut out = Vec::new();
        for &b in chunk {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' => self.end_line(&mut out),
                b'\r' => {
                    self.after_cr = true;
                    self.end_line(&mut out);
                }
                _ => self.line.push(b),
            }
        }
        out
    }

    fn end_line(&mut self, out: &mut Vec<SseItem>) {
        let raw = std::mem::take(&mut self.line);
        let line = String::from_utf8_lossy(&raw);
        if line.is_empty() {
            if let Some(data) = self.data.take() {
                out.push(SseItem::Event {
                    event: self.event.take().unwrap_or_else(|| "message".into()),
                    data,
                    id: self.id.clone(),
                });
            }
            self.event = None;
            return;
        }
        if let Some(c) = line.strip_prefix(':') {
            out.push(SseItem::Comment(c.trim_start().to_string()));
            return;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (&line[..], ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => match &mut self.data {
                Some(d) => {
                    d.push('\n');
                    d.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            "retry" => {
                if let Ok(ms) = value.parse::<u64>() {
                    out.push(SseItem::Retry(ms));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, data: &str) -> SseItem {
        SseItem::Event {
            event: event.into(),
            data: data.into(),
            id: None,
        }
    }

    #[test]
    fn single_event() {
        let mut p = SseParser::new();
        assert_eq!(
            p.push(b"event: session\ndata: {\"a\":1}\n\n"),
            vec![ev("session", "{\"a\":1}")]
        );
    }

    #[test]
    fn multi_line_data_joins_with_newline() {
        let mut p = SseParser::new();
        assert_eq!(
            p.push(b"data: one\ndata: two\ndata:three\n\n"),
            vec![ev("message", "one\ntwo\nthree")]
        );
    }

    #[test]
    fn comments_and_retry() {
        let mut p = SseParser::new();
        let got = p.push(b": ping\n\nretry: 2500\nretry: soon\nevent: x\ndata: y\n\n");
        assert_eq!(
            got,
            vec![
                SseItem::Comment("ping".into()),
                SseItem::Retry(2500),
                ev("x", "y")
            ]
        );
    }

    #[test]
    fn split_across_chunks_and_crlf() {
        let mut p = SseParser::new();
        let mut got = p.push(b"event: snap");
        got.extend(p.push(b"shot\r"));
        got.extend(p.push(b"\ndata: {\"k\":"));
        got.extend(p.push(b"2}\r\n\r\n"));
        assert_eq!(got, vec![ev("snapshot", "{\"k\":2}")]);
    }

    #[test]
    fn event_without_data_is_not_dispatched_and_name_resets() {
        let mut p = SseParser::new();
        assert!(p.push(b"event: lonely\n\n").is_empty());
        assert_eq!(p.push(b"data: z\n\n"), vec![ev("message", "z")]);
    }

    #[test]
    fn id_field_sticks() {
        let mut p = SseParser::new();
        let got = p.push(b"id: 7\ndata: a\n\ndata: b\n\n");
        assert_eq!(
            got,
            vec![
                SseItem::Event {
                    event: "message".into(),
                    data: "a".into(),
                    id: Some("7".into())
                },
                SseItem::Event {
                    event: "message".into(),
                    data: "b".into(),
                    id: Some("7".into())
                },
            ]
        );
    }
}
