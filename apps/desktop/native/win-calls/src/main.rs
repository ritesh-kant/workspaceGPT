//! Line-delimited JSON protocol shared with wgpt-calls.swift / wgpt-notes.swift.
//! No audio files or network access. stdin EOF/stop ends capture.
#[cfg(windows)]
mod windows_audio;

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use wgpt_calls::Chunk;

pub fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{value}").and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

#[cfg(feature = "transcription")]
fn transcribe(
    model: &str,
    rx: mpsc::Receiver<Chunk>,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    whisper_rs::install_logging_hooks();
    let mut options = WhisperContextParameters::default();
    options.use_gpu(false);
    let ctx = WhisperContext::new_with_params(model, options)
        .map_err(|e| format!("Could not load the speech model: {e}"))?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    start()?;
    for chunk in rx {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(
            std::thread::available_parallelism()
                .map_or(2, |n| n.get().saturating_sub(2).clamp(1, 4)) as i32,
        );
        params.set_language(Some("en"));
        params.set_initial_prompt("A work meeting in Indian English and Romanized Hinglish. Haan, theek hai, matlab, chalo. Jira, Confluence, Azure DevOps.");
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_no_speech_thold(0.6);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        state
            .full(params, &chunk.samples)
            .map_err(|e| format!("Transcription failed: {e}"))?;
        for segment in state.as_iter() {
            let text = segment.to_str_lossy().map_err(|e| e.to_string())?;
            let text = text.trim();
            if text.is_empty()
                || segment.no_speech_probability() > 0.6
                || text.starts_with('[')
                || text.starts_with('(')
            {
                continue;
            }
            emit(json!({"type":"segment", "speaker":chunk.speaker,
                "at":chunk.at + segment.start_timestamp() as f64 / 100.0,
                "end":chunk.at + segment.end_timestamp() as f64 / 100.0, "text":text}));
        }
    }
    Ok(())
}

// A detection-only build is useful for validating the Windows audio layer
// from another host. Release builds always use the default transcription feature.
#[cfg(not(feature = "transcription"))]
fn transcribe(
    _: &str,
    _: mpsc::Receiver<Chunk>,
    _: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    Err("This helper was built without transcription support".into())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        emit(
            json!({"version":env!("CARGO_PKG_VERSION"), "transcription":cfg!(feature = "transcription")}),
        );
        return Ok(());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(l) if l.trim() != "stop" => continue,
                _ => break,
            }
        }
        stop.store(true, Ordering::SeqCst);
    });
    #[cfg(windows)]
    {
        if args.iter().any(|a| a == "--detect") {
            return windows_audio::detect(stopped).map_err(|e| format!("Could not inspect active audio sessions: {e}. Turn Detect calls off and on to retry."));
        }
        let model = args
            .windows(2)
            .find(|p| p[0] == "--model")
            .map(|p| p[1].as_str())
            .ok_or("Missing --model")?;
        let pids: Vec<u32> = args
            .windows(2)
            .filter(|p| p[0] == "--pid")
            .filter_map(|p| p[1].parse().ok())
            .filter(|p| *p > 0)
            .collect();
        if pids.is_empty() {
            return Err(
                "The call's audio process is no longer available. Try again during a call.".into(),
            );
        }
        let (tx, rx) = mpsc::sync_channel(16);
        let (finish_tx, finish_rx) = mpsc::channel();
        let capture_stop = stopped.clone();
        let result = transcribe(model, rx, move || {
            // Keep a coordinator off the decoder thread: it drops all senders on
            // stop/error, allowing the decoder to flush the bounded queue and exit.
            std::thread::spawn(move || {
                let result = windows_audio::record(pids, capture_stop, tx);
                let _ = finish_tx.send(result);
            });
            Ok(())
        });
        stopped.store(true, Ordering::SeqCst);
        result?;
        finish_rx.recv().map_err(|e| e.to_string())??;
        emit(json!({"type":"done"}));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // File input exercises the real decoder on other hosts without capturing audio.
        // Raw 16 kHz mono f32le; only used by the native validation command.
        let model = args
            .windows(2)
            .find(|p| p[0] == "--model")
            .map(|p| p[1].as_str())
            .ok_or("Missing --model")?;
        let input = args
            .windows(2)
            .find(|p| p[0] == "--test-pcm")
            .map(|p| p[1].as_str())
            .ok_or("Windows is required for live audio")?;
        let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
        let samples = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let (tx, rx) = mpsc::channel();
        tx.send(Chunk {
            speaker: "others",
            at: 0.0,
            samples,
        })
        .unwrap();
        drop(tx);
        transcribe(model, rx, || Ok(()))
    }
}

fn main() {
    if let Err(message) = run() {
        emit(json!({"type":"error", "message":message}));
        std::process::exit(2);
    }
}
