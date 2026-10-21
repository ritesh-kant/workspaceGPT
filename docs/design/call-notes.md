# Call notes (desktop app only)

Status: design, 2026-10-21. Nothing built. The call-detection signals still need
one real Teams call per OS to confirm (see "Validate first").

## What it does

When call notes are turned on, the desktop app notices that the user is in a
Microsoft Teams call and **asks** whether to take notes. If the user says yes, it
records the call, transcribes it on the device, and adds the transcript to a new
**Meetings** Knowledge source. The agent can then answer questions such as
"what did we decide about the retry cap in Tuesday's call?" and cite the call.

It fits the north star on both counts. Meetings are org knowledge, and the
audio, transcription and index never leave the machine.

**Desktop only.** Capture and transcription need native helpers, and the VS
Code extension never offers this. The settings are gated on `isDesktopHost()`,
and the native pieces live in `apps/desktop` (`native/` and `src-tauri/`), not in
extension code. This follows the rule that desktop must not fork extension code.

## Non-negotiables

- **Nothing records without a click.** Detecting a call only ever triggers a
  prompt. If the prompt is dismissed or ignored, nothing is recorded. There is
  no blanket "always record" setting.
- **It is always visible while recording.** An indicator with Stop shows the
  whole time, and recording stops by itself when the call ends.
- **Other participants are reminded.** The prompt reminds the user to tell
  participants, and offers a one-click copy of a short line for the meeting
  chat. The user's click is their own consent, not the other participants'.
  Laws differ: several US states require all-party consent, and under GDPR a
  voice is personal data. Employer and client policies also apply.
- **It stays on the device.** Audio is deleted after transcription unless the
  user chooses to keep it. Transcripts can be deleted call by call. Nothing is
  uploaded. Analytics carry no content: only events like
  `call_notes_started` and `call_notes_stopped` with a duration.

## Flow

1. **Detect.** A cheap poll every few seconds checks whether Teams holds the
   microphone (see "Detection"). The signal must hold for about 10 s before
   anything happens, so a mic test or a voice note doesn't trigger it. Only
   one prompt is shown per call.
2. **Prompt.** A native notification says "Teams call detected. Click to take
   notes." It reuses the `notify.rs` path, which has no action buttons today.
   Clicking it opens an in-app card with three choices:
   - **Record & transcribe**
   - **Not this call**
   - **Never for this meeting**: this needs the Outlook Calendar source to
     identify a recurring meeting; without it, the choice becomes "don't ask
     again today".
3. **Record.** Capture starts on two separate tracks: the microphone ("You")
   and Teams' own audio output ("Others"). The indicator and Stop are shown.
4. **End.** Recording stops when the detection signal drops for about 15 s,
   or when the user clicks Stop.
5. **Transcribe.** Transcription runs on the device, chunk by chunk during the
   call or all at once after it. Speaker labels come from the two tracks
   ("You" / "Others"). Telling individual people apart is out of scope for v1.
6. **Store.** The transcript, a short summary, and metadata (start, duration,
   and title and attendees when the calendar can match the meeting) are saved
   and embedded into the on-device index as the Meetings source.

## Detection

The goal is a plain "in a Teams call: yes/no" that works muted and with the
camera off, needs no permission prompt, and needs no Microsoft approval. The
key assumption is that **Teams keeps the microphone open while muted**. Mute is
a software mute, which is how Teams can warn "You're muted" when the user
speaks. That assumption needs testing.

**Windows.** Windows records which app is using the microphone; this record
drives the taskbar mic icon. It lives in the user's own registry, readable
without admin rights:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\MSTeams_8wekyb3d8bbwe
```

New Teams is an MSIX package. While it holds the mic, `LastUsedTimeStop` is 0.
The check can be read with `reg query`, so no native code is needed.
`powercfg /requests` would add a second signal, but it needs admin rights, so
it is not used.

**macOS.** On macOS 14 and later, Core Audio can report whether a specific
process is running audio input (the process object list, input-running per
process). As a backup signal, Teams holds a "prevent display sleep" power
assertion during a call. The `pmset -g assertions` list shows these per
process, and reading it needs no permission. Both checks go in a small Swift
helper next to `wgpt-dictate`.

**Not covered:**
- Teams running in a browser tab: the mic then belongs to Chrome or Edge, so
  the call can't be told apart from other web calls.
- Other meeting apps such as Zoom or Meet. They are possible later with the
  same signals.

**Rejected:**
- Reading window titles: macOS requires Screen Recording permission.
- Parsing Teams' private log files: undocumented and fragile.
- Teams' local third-party API: precise, but the user must enable it in Teams
  settings and pair it.
- Graph presence: needs Microsoft app approval, which locked-down tenants
  won't give.

## Capture

| | Microphone ("You") | Teams output ("Others") |
|---|---|---|
| **macOS** | AVAudioEngine input. Uses the microphone permission, which dictation already prompts for. | Core Audio process tap on the Teams process (macOS 14.2+). Needs a one-time "System Audio Recording" permission (`NSAudioCaptureUsageDescription`). |
| **Windows** | WASAPI capture. Subject to the Windows mic privacy toggle for desktop apps. | WASAPI process loopback for the Teams process (Windows 10 2004+). No prompt. |

Both tracks are written as 16 kHz mono WAV chunks into the app's data folder,
and each chunk is deleted once it has been transcribed.

## Transcription

**macOS: Apple's on-device recognizer.** This is the same family as dictation.
On macOS 26 and later, use `SpeechAnalyzer` / `SpeechTranscriber`, which are
built for long-form audio. On older macOS, use `SFSpeechRecognizer` with
`requiresOnDeviceRecognition = true`, fed in chunks. The locale is `en-IN`
when the device supports it on-device; otherwise `en-US`. Hinglish words come
out as their nearest English rendering. That is acceptable, since meetings
are mostly English.

**Windows: Whisper through whisper.cpp.** whisper.cpp is MIT-licensed and has
prebuilt Windows binaries that run on the CPU, with optional GPU. It runs as a
helper process.
- **Default model:** multilingual `small`, quantized (about 180 MB). Not the
  `.en` variant, because of Hinglish.
- **Light tier:** `base` (about 60 MB).
- **Best tier:** `large-v3-turbo` (about 550 MB), practical when transcribing
  after the call.
- **Download:** the model is downloaded the first time the feature is turned
  on, and verified against its checksum. It is never bundled; the installer's
  size matters (see the 154 MB pruning).
- **Settings:** language `en`, plus an initial prompt in Romanized Hinglish.
  Together they keep the output in Roman script rather than switching a
  chunk to Devanagari. This needs testing on real meetings.

Alternatives that were weighed and set aside:
- NVIDIA Parakeet: the English model is English-only, and the multilingual
  one covers European languages, not Hindi.
- Moonshine: built for short live phrases.
- Windows' built-in speech recognition: well below Whisper's accuracy.
- Vosk: older and less accurate.

## Meetings as Knowledge

- **Storage:** one Markdown file per call, kept in the app's data folder:
  - front matter: date, duration and, when the calendar matches, the
    meeting's title and attendees;
  - a summary;
  - the transcript with "You:" / "Others:" turns and timestamps.

  This mirrors how Confluence and ADO items are synced to Markdown and then
  embedded.
- **Index:** embedded with the existing on-device embedding worker, under a new
  `MEETINGS` namespace.
- **Settings → Knowledge → Meetings:**
  - turn call notes on or off;
  - pick the Windows model tier;
  - list, open and delete calls;
  - keep audio (off by default).
- **Agent tools:**
  - `search_meetings(query, since)`: semantic search over the index;
  - `get_meeting(id)`: one call's full transcript.

## Validate first

Before building, run a small probe on each OS, in one real Teams call that is
**muted with the camera off**:
- **Windows (PowerShell):** print the Teams `LastUsedTimeStop` every few
  seconds.
- **macOS (Swift):** print whether the Teams process has input running, plus
  the Teams power assertions.

If the signal stays "yes" for the whole muted call, build on it. If not,
detection falls back to Teams' local API, which the user enables once in Teams.

The probes are in `apps/desktop/native/probes/`:

```bash
swift apps/desktop/native/probes/teams-call-probe.swift
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\teams-call-probe.ps1
```

Each prints every app holding the mic, not only Teams, so the run also shows
*which* process holds it. New Teams may capture through a helper process (a
WebView helper on Mac, `msedgewebview2.exe` on Windows), and detection must
match that process.

The macOS probe was checked on macOS 27 with no call running. It reported
"no call", and the per-process listing worked: `afplay` appeared while a sound
played. It also showed the "Hey Siri" listener (`corespeechd`) holding input.
That is why detection must match the Teams process and never use "is anyone
using the mic". The Windows probe has not been run; no Windows machine was
available.

## Effort (rough)

| Piece | Estimate |
|---|---|
| Detection helpers and the prompt flow | 3 days |
| Capture on macOS (mic and process tap) | 3 days |
| Capture on Windows (mic and process loopback) | 3 days |
| Transcription on macOS (Speech) | 2 days |
| Transcription on Windows (whisper.cpp helper and model download) | 3 days |
| Meetings Knowledge source, tools and settings | 3 days |

That is about three weeks for v1, after the probes pass.

## Open questions

- Should the summary use the user's selected model? That sends transcript
  text to the model like any tool result. The alternative is to summarize
  only on demand when the agent reads a meeting.
- Should "Never for this meeting" exist without the Outlook Calendar source,
  or fall back to "don't ask again today"?
- What retention default should transcripts have (keep forever, or 90 days)?
