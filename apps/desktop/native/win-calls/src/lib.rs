//! Audio remains in memory. Bound each track and the decode queue so a slow CPU
//! cannot accumulate a meeting's worth of audio.
pub const RATE: usize = 16_000;

pub struct Chunk {
    pub speaker: &'static str,
    pub at: f64,
    pub samples: Vec<f32>,
}

pub struct Track {
    speaker: &'static str,
    samples: Vec<f32>,
    at: f64,
    speech: usize,
    silence: usize,
}

impl Track {
    pub fn new(speaker: &'static str) -> Self {
        Self {
            speaker,
            samples: Vec::new(),
            at: 0.0,
            speech: 0,
            silence: 0,
        }
    }

    // Called with 10 ms frames. Cut at a pause after 8 s, or at 28 s even
    // without a pause. Require half a second of speech to avoid hallucinations.
    pub fn push(&mut self, frame: &[f32], at: f64) -> Option<Chunk> {
        if self.samples.is_empty() {
            self.at = at;
        }
        let rms = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len().max(1) as f32).sqrt();
        if rms >= 0.008 {
            self.speech += frame.len();
            self.silence = 0;
        } else {
            self.silence += frame.len();
        }
        self.samples.extend_from_slice(frame);
        if self.samples.len() >= 28 * RATE
            || (self.samples.len() >= 8 * RATE && self.silence >= RATE / 2)
        {
            return self.finish();
        }
        None
    }

    pub fn finish(&mut self) -> Option<Chunk> {
        let samples = std::mem::take(&mut self.samples);
        let heard = self.speech >= RATE / 2;
        self.speech = 0;
        self.silence = 0;
        heard.then_some(Chunk {
            speaker: self.speaker,
            at: self.at,
            samples,
        })
    }
}

// Browsers can put capture and rendering in different child processes. Group
// only same-executable ancestors; never climb into explorer.exe and group apps.
pub fn application_root(mut pid: u32, map: &std::collections::HashMap<u32, (u32, String)>) -> u32 {
    let mut seen = std::collections::BTreeSet::new();
    while seen.insert(pid) {
        let Some((parent, name)) = map.get(&pid) else {
            break;
        };
        if !map
            .get(parent)
            .is_some_and(|(_, n)| n.eq_ignore_ascii_case(name))
        {
            break;
        }
        pid = *parent;
    }
    pid
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_helpers_share_a_root_but_unrelated_apps_do_not() {
        let map = std::collections::HashMap::from([
            (1, (0, "explorer.exe".into())),
            (2, (1, "chrome.exe".into())),
            (3, (2, "chrome.exe".into())),
            (4, (2, "chrome.exe".into())),
            (5, (1, "Zoom.exe".into())),
        ]);
        assert_eq!(application_root(3, &map), application_root(4, &map));
        assert_ne!(application_root(3, &map), application_root(5, &map));
    }
    #[test]
    fn silence_is_bounded_and_never_transcribed() {
        let mut track = Track::new("you");
        for i in 0..10_000 {
            assert!(track.push(&[0.0; 160], i as f64 / 100.0).is_none());
        }
        assert!(track.samples.len() < 8 * RATE);
        assert!(track.finish().is_none());
    }
    #[test]
    fn pauses_cut_chunks_and_preserve_wall_clock_offsets() {
        let mut track = Track::new("others");
        for i in 0..750 {
            assert!(track.push(&[0.1; 160], 12.0 + i as f64 / 100.0).is_none());
        }
        for i in 0..49 {
            assert!(track.push(&[0.0; 160], 19.5 + i as f64 / 100.0).is_none());
        }
        let chunk = track.push(&[0.0; 160], 19.99).unwrap();
        assert_eq!(chunk.at, 12.0);
        assert_eq!(chunk.samples.len(), 8 * RATE);
        assert_eq!(chunk.speaker, "others");
        assert!(track.finish().is_none());
    }
    #[test]
    fn continuous_speech_is_cut_and_stop_flushes_the_tail() {
        let mut track = Track::new("you");
        let mut chunks = Vec::new();
        for i in 0..3000 {
            if let Some(c) = track.push(&[0.1; 160], i as f64 / 100.0) {
                chunks.push(c);
            }
        }
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].samples.len(), 28 * RATE);
        assert_eq!(track.finish().unwrap().samples.len(), 2 * RATE);
    }
}
