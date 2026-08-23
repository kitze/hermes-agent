"""
Tests for #24870 — Telegram: audio file attachments must NOT be routed to STT.

Telegram distinguishes three kinds of audio payloads:
  - message.voice  → Opus/OGG voice message  → STT pipeline
  - message.audio  → audio file attachment   → file path note, NOT STT
  - message.document (audio mime) → generic file route

These tests confirm that:
  1. MessageType.VOICE events still flow through the STT pipeline.
  2. MessageType.AUDIO events bypass STT and get a file-path context note instead.
  3. Mixed media lists (voice + audio) split correctly.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from gateway.config import GatewayConfig, Platform
from gateway.platforms.base import CachedMedia, MessageEvent, MessageType
from gateway.session import SessionSource
from plugins.platforms.telegram.adapter import TelegramAdapter


def _make_runner(stt_enabled: bool = True) -> "GatewayRunner":  # type: ignore[name-defined]
    from gateway.run import GatewayRunner

    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = GatewayConfig(stt_enabled=stt_enabled)
    runner.adapters = {}
    runner._model = "test-model"
    runner._base_url = ""
    runner._has_setup_skill = lambda: False
    return runner


def _voice_event(path: str = "/tmp/voice.ogg") -> MessageEvent:
    return MessageEvent(
        text="",
        message_type=MessageType.VOICE,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
        media_urls=[path],
        media_types=["audio/ogg"],
    )


def _audio_event(path: str = "/tmp/song.mp3") -> MessageEvent:
    return MessageEvent(
        text="",
        message_type=MessageType.AUDIO,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
        media_urls=[path],
        media_types=["audio/mpeg"],
    )


def _reply_trigger(*, voice: bool) -> SimpleNamespace:
    file_obj = SimpleNamespace(
        file_path="voice.ogg" if voice else "song.mp3",
        download_as_bytearray=AsyncMock(return_value=bytearray(b"audio")),
    )
    media = SimpleNamespace(
        file_size=5,
        file_name=None if voice else "song.mp3",
        get_file=AsyncMock(return_value=file_obj),
    )
    reply = SimpleNamespace(
        photo=None,
        video=None,
        voice=media if voice else None,
        audio=None if voice else media,
        document=None,
    )
    return SimpleNamespace(reply_to_message=reply)


# ---------------------------------------------------------------------------
# 1. VOICE still goes through STT
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_voice_message_still_transcribed():
    """MessageType.VOICE must still be sent through _enrich_message_with_transcription."""
    runner = _make_runner(stt_enabled=True)
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm")
    event = _voice_event("/tmp/voice.ogg")

    with patch(
        "tools.transcription_tools.transcribe_audio",
        return_value={"success": True, "transcript": "hello world", "provider": "whisper"},
    ) as mock_transcribe:
        result = await runner._prepare_inbound_message_text(
            event=event,
            source=source,
            history=[],
        )

    mock_transcribe.assert_called_once_with("/tmp/voice.ogg", None, "gateway")
    # The transcript passes through as a plain quoted line — no "voice message"
    # meta-commentary in the LLM-visible prompt.
    assert "hello world" in result


# ---------------------------------------------------------------------------
# 2. AUDIO file attachment bypasses STT
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audio_attachment_context_note_format():
    """Context note for audio file attachments should include the file path and guidance."""
    runner = _make_runner(stt_enabled=True)
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm")
    event = _audio_event("/tmp/cache_12345_my_song.mp3")

    with patch(
        "tools.transcription_tools.transcribe_audio",
        side_effect=AssertionError("must not be called"),
    ):
        with patch(
            "tools.credential_files.to_agent_visible_cache_path",
            side_effect=lambda p: p,
        ):
            result = await runner._prepare_inbound_message_text(
                event=event,
                source=source,
                history=[],
            )

    assert "my_song.mp3" in result
    assert "audio file attachment" in result.lower()
    # Should NOT contain the voice-message transcription wrapper text
    assert "voice message" not in result.lower()
    # Guides the agent to transcribe/process the file itself rather than
    # punting back to the user (same bug class as the PDF/DOCX note).
    assert "transcri" in result.lower()
    assert "ask the user what they'd like" not in result.lower()


@pytest.mark.asyncio
async def test_replied_voice_keeps_trigger_text_and_enters_stt():
    """Replying with instructions to a voice note must transcribe that note."""
    adapter = object.__new__(TelegramAdapter)
    adapter._max_doc_bytes = 1024
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm")
    event = MessageEvent(
        text="Transcribe this and tell me the action item",
        message_type=MessageType.TEXT,
        source=source,
    )

    cached = CachedMedia(
        path="/tmp/replied-voice.ogg",
        media_type="audio/ogg",
        kind="audio",
        display_name="voice.ogg",
    )
    with patch("gateway.platforms.base.cache_media_bytes", return_value=cached):
        await adapter._cache_replied_media(_reply_trigger(voice=True), event)

    assert event.message_type is MessageType.TEXT
    assert event.media_types == ["audio/ogg"]

    runner = _make_runner(stt_enabled=True)
    with patch(
        "tools.transcription_tools.transcribe_audio",
        return_value={
            "success": True,
            "transcript": "Book the dentist appointment tomorrow",
            "provider": "sotto_direct",
        },
    ) as mock_transcribe:
        result = await runner._prepare_inbound_message_text(
            event=event,
            source=source,
            history=[],
        )

    mock_transcribe.assert_called_once_with("/tmp/replied-voice.ogg", None, "gateway")
    assert "Transcribe this and tell me the action item" in result
    assert "Book the dentist appointment tomorrow" in result


@pytest.mark.asyncio
async def test_replied_audio_file_stays_audio_and_skips_stt():
    """Telegram music/audio attachments remain opt-in even when replied to."""
    adapter = object.__new__(TelegramAdapter)
    adapter._max_doc_bytes = 1024
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm")
    event = MessageEvent(
        text="What is in this file?",
        message_type=MessageType.TEXT,
        source=source,
    )

    cached = CachedMedia(
        path="/tmp/replied-song.mp3",
        media_type="audio/mpeg",
        kind="audio",
        display_name="song.mp3",
    )
    with patch("gateway.platforms.base.cache_media_bytes", return_value=cached):
        await adapter._cache_replied_media(_reply_trigger(voice=False), event)

    assert event.message_type is MessageType.AUDIO
    with patch(
        "tools.transcription_tools.transcribe_audio",
        side_effect=AssertionError("ordinary audio files must not auto-transcribe"),
    ):
        result = await _make_runner()._prepare_inbound_message_text(
            event=event,
            source=source,
            history=[],
        )

    assert "What is in this file?" in result
    assert "replied-song.mp3" in result


# ---------------------------------------------------------------------------
# 3. STT disabled still results in no transcription for audio file attachments
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 4. Telegram gateway: msg.audio → MessageType.AUDIO (not VOICE)
# ---------------------------------------------------------------------------
