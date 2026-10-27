//! wgpt-mic: the default microphone as raw 16 kHz mono signed 16-bit little-endian PCM on stdout.
//!
//! Started by sidecar/host/dictation.ts on Windows, which feeds the samples to an on-device
//! speech recognizer. Ends when stdin reads "stop" or closes (the sidecar going away must not
//! leave the mic open). Problems are one line on stderr, `ERR <code> <message>`, then exit 2.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::io::{BufRead, Write};

const TARGET_RATE: f64 = 16_000.0;

fn fail(code: &str, message: &str) -> ! {
    eprintln!("ERR {code} {message}");
    std::process::exit(2);
}

/// Mixes to mono and resamples to 16 kHz by linear interpolation, carrying its position across callbacks.
struct Resampler {
    step: f64,
    channels: usize,
    pos: f64,
    prev: f32,
    has_prev: bool,
}

impl Resampler {
    fn new(rate: u32, channels: u16) -> Self {
        Resampler { step: rate as f64 / TARGET_RATE, channels: channels.max(1) as usize, pos: 0.0, prev: 0.0, has_prev: false }
    }

    fn push(&mut self, frames: &[f32], out: &mut Vec<u8>) {
        for frame in frames.chunks(self.channels) {
            let cur = frame.iter().sum::<f32>() / frame.len() as f32;
            if !self.has_prev {
                self.prev = cur;
                self.has_prev = true;
                continue;
            }
            // `pos` is measured from `prev`; every output sample lies between prev and cur.
            while self.pos < 1.0 {
                let v = self.prev + (cur - self.prev) * self.pos as f32;
                let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
                out.extend_from_slice(&s.to_le_bytes());
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = cur;
        }
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut resampler = Resampler::new(config.sample_rate.0, config.channels);
    let mut floats: Vec<f32> = Vec::new();
    let mut bytes: Vec<u8> = Vec::new();
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            floats.clear();
            floats.extend(data.iter().map(|s| s.to_sample::<f32>()));
            bytes.clear();
            resampler.push(&floats, &mut bytes);
            let mut out = std::io::stdout().lock();
            // The reader is gone: nothing left to capture for.
            if out.write_all(&bytes).and_then(|_| out.flush()).is_err() {
                std::process::exit(0);
            }
        },
        |err| fail("stream", &err.to_string()),
        None,
    )
}

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().unwrap_or_else(|| fail("no-device", "No microphone was found."));
    let supported = device.default_input_config().unwrap_or_else(|e| fail("mic-denied", &format!("The microphone could not be opened: {e}")));
    let config: cpal::StreamConfig = supported.clone().into();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config),
        SampleFormat::I16 => build::<i16>(&device, &config),
        SampleFormat::U16 => build::<u16>(&device, &config),
        SampleFormat::I32 => build::<i32>(&device, &config),
        other => fail("format", &format!("Unsupported microphone format {other:?}.")),
    }
    .unwrap_or_else(|e| fail("mic-denied", &format!("The microphone could not be opened: {e}")));
    stream.play().unwrap_or_else(|e| fail("mic-denied", &format!("The microphone could not be started: {e}")));

    for line in std::io::stdin().lock().lines() {
        match line {
            Ok(l) if l.trim() != "stop" => continue,
            _ => break,
        }
    }
    drop(stream);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_stereo_to_16k_mono() {
        let mut r = Resampler::new(48_000, 2);
        let mut out = Vec::new();
        // One second of a constant 0.5 on both channels.
        r.push(&vec![0.5f32; 48_000 * 2], &mut out);
        let samples = out.len() / 2;
        assert!((15_990..=16_010).contains(&samples), "{samples}");
        assert_eq!(i16::from_le_bytes([out[100], out[101]]), (0.5f32 * 32767.0) as i16);
    }

    #[test]
    fn resamples_44k1_mono_across_calls() {
        let mut r = Resampler::new(44_100, 1);
        let mut out = Vec::new();
        for _ in 0..100 {
            r.push(&vec![0.0f32; 441], &mut out);
        }
        let samples = out.len() / 2;
        assert!((15_990..=16_010).contains(&samples), "{samples}");
    }
}
