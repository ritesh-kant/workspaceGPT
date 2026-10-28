use crate::emit;
use serde_json::json;
use std::collections::{BTreeSet, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};
use wasapi::*;
use wgpt_calls::{application_root, Chunk, Track, RATE};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{IAudioCaptureClient, AUDCLNT_BUFFERFLAGS_SILENT};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

type Result<T> = std::result::Result<T, String>;

fn processes() -> Result<HashMap<u32, (u32, String)>> {
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut map = HashMap::new();
        let mut next = Process32FirstW(handle, &mut entry);
        while next.is_ok() {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            map.insert(
                entry.th32ProcessID,
                (
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                ),
            );
            next = Process32NextW(handle, &mut entry);
        }
        let _ = CloseHandle(handle);
        Ok(map)
    }
}

fn active(direction: Direction) -> Result<BTreeSet<u32>> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let devices = enumerator
        .get_device_collection(&direction)
        .map_err(|e| e.to_string())?;
    let count = devices.get_nbr_devices().map_err(|e| e.to_string())?;
    let mut pids = BTreeSet::new();
    let mut read = 0;
    let mut last_error = String::new();
    for i in 0..count {
        let sessions = (|| {
            let device = devices.get_device_at_index(i)?;
            device
                .get_iaudiosessionmanager()?
                .get_audiosessionenumerator()
        })();
        match sessions {
            Ok(sessions) => {
                let count = match sessions.get_count() {
                    Ok(count) => count,
                    Err(e) => {
                        last_error = e.to_string();
                        continue;
                    }
                };
                read += 1;
                for i in 0..count {
                    // A process can exit between enumeration and these reads.
                    // Losing that session is normal; endpoint-wide failures above
                    // still surface when no device could be inspected.
                    let Ok(session) = sessions.get_session(i) else {
                        continue;
                    };
                    if session.get_state().ok() == Some(SessionState::Active) {
                        if let Ok(pid) = session.get_process_id() {
                            if pid > 0 {
                                pids.insert(pid);
                            }
                        }
                    }
                }
            }
            Err(e) => last_error = e.to_string(),
        }
    }
    if count > 0 && read == 0 {
        return Err(last_error);
    }
    Ok(pids)
}

pub fn detect(stopped: Arc<AtomicBool>) -> Result<()> {
    initialize_mta().ok().map_err(|e| e.to_string())?;
    while !stopped.load(Ordering::SeqCst) {
        let map = processes()?;
        let capture = active(Direction::Capture)?;
        let render = active(Direction::Render)?;
        let output: BTreeSet<u32> = render
            .into_iter()
            .map(|p| application_root(p, &map))
            .collect();
        let mut holders = BTreeSet::new();
        for pid in capture {
            let pid = application_root(pid, &map);
            let name = map
                .get(&pid)
                .map(|(_, n)| n.to_lowercase())
                .unwrap_or_default();
            if pid != std::process::id()
                && name != "wgpt-mic.exe"
                && name != "wgpt-calls.exe"
                && output.contains(&pid)
            {
                holders.insert(pid);
            }
        }
        emit(
            json!({"holders":holders.into_iter().map(|pid| json!({"pid":pid, "name":map.get(&pid).map(|(_, n)| n.as_str()).unwrap_or("Call app")})).collect::<Vec<_>>() }),
        );
        std::thread::sleep(Duration::from_secs(1));
    }
    Ok(())
}

// Follow the microphone used by the call, including a headset that is not the
// system default. Device switching stops with a visible error rather than silently
// saving a transcript from the wrong microphone.
fn call_microphone(pids: &[u32]) -> Result<String> {
    initialize_mta().ok().map_err(|e| e.to_string())?;
    let map = processes()?;
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let devices = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|e| e.to_string())?;
    for i in 0..devices.get_nbr_devices().map_err(|e| e.to_string())? {
        let device = devices.get_device_at_index(i).map_err(|e| e.to_string())?;
        let sessions = device
            .get_iaudiosessionmanager()
            .and_then(|m| m.get_audiosessionenumerator())
            .map_err(|e| e.to_string())?;
        for j in 0..sessions.get_count().map_err(|e| e.to_string())? {
            let session = sessions.get_session(j).map_err(|e| e.to_string())?;
            if session.get_state().map_err(|e| e.to_string())? == SessionState::Active
                && pids.contains(&application_root(
                    session.get_process_id().map_err(|e| e.to_string())?,
                    &map,
                ))
            {
                return device.get_id().map_err(|e| e.to_string());
            }
        }
    }
    Err("The call's microphone is no longer available. Try again during a call.".into())
}

fn capture(
    pid: Option<u32>,
    mic_device: String,
    stopped: Arc<AtomicBool>,
    tx: mpsc::SyncSender<Chunk>,
    ready: mpsc::Sender<Result<()>>,
    started: Instant,
) -> Result<()> {
    initialize_mta().ok().map_err(|e| e.to_string())?;
    let mut client = if let Some(pid) = pid {
        AudioClient::new_application_loopback_client(pid, true).map_err(|e| format!("Could not capture the call app's audio. Windows build 20348 or newer is required: {e}"))?
    } else {
        DeviceEnumerator::new()
            .and_then(|e| e.get_device(&mic_device))
            .and_then(|d| d.get_iaudioclient())
            .map_err(|e| {
                format!(
                    "Could not open the microphone. Check Windows microphone privacy settings: {e}"
                )
            })?
    };
    // WASAPI performs channel conversion and resampling, including process loopback.
    let format = WaveFormat::new(32, 32, &SampleType::Float, RATE, 1, None);
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: 1_000_000,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;
    let input: IAudioCaptureClient =
        unsafe { client.as_iaudioclient().GetService() }.map_err(|e| e.to_string())?;
    if stopped.load(Ordering::SeqCst) {
        let _ = ready.send(Ok(()));
        return Ok(());
    }
    client.start_stream().map_err(|e| e.to_string())?;
    let _ = ready.send(Ok(()));
    let speaker = if pid.is_some() { "others" } else { "you" };
    let mut track = Track::new(speaker);
    let mut last_packet = Instant::now();
    while !stopped.load(Ordering::SeqCst) {
        while unsafe { input.GetNextPacketSize() }.map_err(|e| e.to_string())? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0;
            let mut flags = 0;
            unsafe { input.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(|e| e.to_string())?;
            // WASAPI permits a null pointer for a silent packet. Never dereference
            // it: the wasapi crate's convenience reader currently does so.
            let samples = if frames == 0
                || flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
                || data.is_null()
            {
                vec![0.0; frames as usize]
            } else {
                unsafe { std::slice::from_raw_parts(data.cast::<f32>(), frames as usize) }.to_vec()
            };
            unsafe { input.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?;
            let end = started.elapsed().as_secs_f64();
            for (i, frame) in samples.chunks(160).enumerate() {
                let at = (end - (samples.len() - i * 160) as f64 / RATE as f64).max(0.0);
                if let Some(chunk) = track.push(frame, at) {
                    tx.try_send(chunk).map_err(|_| "This computer could not transcribe the call fast enough. Notes stopped to avoid accumulating audio in memory.".to_string())?;
                }
            }
            last_packet = Instant::now();
        }
        // Process loopback can produce no packets at all while the app is silent.
        // Flush at the gap so later speech retains its actual wall-clock offset.
        if last_packet.elapsed() >= Duration::from_millis(500) {
            if let Some(chunk) = track.finish() {
                tx.try_send(chunk).map_err(|e| e.to_string())?;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = client.stop_stream();
    if let Some(chunk) = track.finish() {
        let _ = tx.send(chunk);
    }
    Ok(())
}

pub fn record(pids: Vec<u32>, stopped: Arc<AtomicBool>, tx: mpsc::SyncSender<Chunk>) -> Result<()> {
    if stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mic_device = call_microphone(&pids)?;
    let started = Instant::now();
    let (ready_tx, ready_rx) = mpsc::channel();
    let mut threads = Vec::new();
    let mut count = 0;
    for pid in std::iter::once(None).chain(pids.into_iter().map(Some)) {
        count += 1;
        let stop = stopped.clone();
        let sender = tx.clone();
        let ready = ready_tx.clone();
        let mic_device = mic_device.clone();
        threads.push(std::thread::spawn(move || {
            let result = capture(
                pid,
                mic_device,
                stop.clone(),
                sender,
                ready.clone(),
                started,
            );
            if let Err(ref error) = result {
                let _ = ready.send(Err(error.clone()));
                emit(json!({"type":"error", "message":error}));
                stop.store(true, Ordering::SeqCst);
            }
            result
        }));
    }
    drop(ready_tx);
    let mut failure = None;
    for _ in 0..count {
        match ready_rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                failure = Some(e);
                break;
            }
            Err(e) => {
                failure = Some(format!("Audio capture did not start: {e}"));
                break;
            }
        }
    }
    if failure.is_some() {
        stopped.store(true, Ordering::SeqCst);
    } else {
        emit(json!({"type":"state", "state":"recording"}));
    }
    while !stopped.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }
    emit(json!({"type":"state", "state":"finishing"}));
    for thread in threads {
        if let Err(e) = thread
            .join()
            .unwrap_or_else(|_| Err("Audio capture thread failed".into()))
        {
            failure.get_or_insert(e);
        }
    }
    drop(tx);
    failure.map_or(Ok(()), Err)
}
