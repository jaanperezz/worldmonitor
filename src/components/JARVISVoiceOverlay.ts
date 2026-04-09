/**
 * JARVIS Voice Overlay
 *
 * Floating overlay (not in panel grid). Activated by:
 *   - Clicking the mic button
 *   - Saying "hey jarvis" (wake word via Web Speech API continuous mode)
 *
 * Flow: wake word → listen → POST /api/jarvis-voice → stream → TTS
 */

// Web Speech API types (not in all TS DOM libs)
declare class SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const WAKE_WORD = 'hey jarvis';
const MAX_HISTORY = 10;
const API_URL = '/api/jarvis-voice';

export class JARVISVoiceOverlay {
  private el!: HTMLElement;
  private statusEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private responseEl!: HTMLElement;
  private micBtn!: HTMLButtonElement;

  private recognition: SpeechRecognition | null = null;
  private synth = window.speechSynthesis;
  private history: ChatMessage[] = [];
  private isListening = false;
  private isProcessing = false;
  private streamAbort: AbortController | null = null;

  constructor() {
    this.buildDOM();
    this.initWakeWord();
  }

  private buildDOM(): void {
    this.el = document.createElement('div');
    this.el.id = 'jarvis-overlay';
    this.el.innerHTML = `
      <div class="jarvis-orb-wrap">
        <button class="jarvis-mic" title="Talk to JARVIS (or say 'Hey JARVIS')">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>
      </div>
      <div class="jarvis-panel" hidden>
        <div class="jarvis-status">Ready</div>
        <div class="jarvis-transcript"></div>
        <div class="jarvis-response"></div>
        <button class="jarvis-close">✕</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #jarvis-overlay {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999;
        font-family: 'Inter', system-ui, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 12px;
      }
      .jarvis-orb-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .jarvis-mic {
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: #0d1117;
        border: 1.5px solid #30363d;
        color: #8b949e;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      }
      .jarvis-mic:hover { border-color: #58a6ff; color: #58a6ff; }
      .jarvis-mic.listening {
        border-color: #f85149;
        color: #f85149;
        animation: jarvis-pulse 1.2s ease-in-out infinite;
      }
      .jarvis-mic.processing {
        border-color: #58a6ff;
        color: #58a6ff;
        animation: jarvis-pulse 0.8s ease-in-out infinite;
      }
      @keyframes jarvis-pulse {
        0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
        50% { box-shadow: 0 0 0 8px transparent; opacity: 0.85; }
      }
      .jarvis-panel {
        position: relative;
        width: 340px;
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }
      .jarvis-status {
        font-size: 11px;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 8px;
      }
      .jarvis-transcript {
        font-size: 13px;
        color: #58a6ff;
        min-height: 18px;
        margin-bottom: 10px;
        font-style: italic;
      }
      .jarvis-response {
        font-size: 14px;
        color: #e6edf3;
        line-height: 1.6;
        max-height: 220px;
        overflow-y: auto;
        white-space: pre-wrap;
      }
      .jarvis-close {
        position: absolute;
        top: 10px;
        right: 10px;
        background: none;
        border: none;
        color: #8b949e;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 2px 6px;
      }
      .jarvis-close:hover { color: #e6edf3; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(this.el);

    this.micBtn = this.el.querySelector('.jarvis-mic')!;
    this.statusEl = this.el.querySelector('.jarvis-status')!;
    this.transcriptEl = this.el.querySelector('.jarvis-transcript')!;
    this.responseEl = this.el.querySelector('.jarvis-response')!;

    this.micBtn.addEventListener('click', () => this.toggleListen());
    this.el.querySelector('.jarvis-close')!.addEventListener('click', () => this.closePanel());
  }

  private initWakeWord(): void {
    const SR = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SR) return;

    const wake = new SR();
    wake.continuous = true;
    wake.interimResults = true;
    wake.lang = 'es-ES';

    wake.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = (e.results[i]?.[0]?.transcript ?? '').toLowerCase();
        if (text.includes(WAKE_WORD) && !this.isListening && !this.isProcessing) {
          this.startListening();
          break;
        }
      }
    };

    wake.onend = () => {
      if (!this.isListening) setTimeout(() => wake.start(), 500);
    };

    try { wake.start(); } catch { /* browser may block until user gesture */ }
  }

  private toggleListen(): void {
    if (this.isListening) {
      this.stopListening();
    } else {
      this.startListening();
    }
  }

  private startListening(): void {
    const SR = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SR) {
      this.showPanel('Web Speech API not supported in this browser.');
      return;
    }

    this.isListening = true;
    this.micBtn.classList.add('listening');
    this.showPanel();
    this.setStatus('Listening…');
    this.transcriptEl.textContent = '';
    this.responseEl.textContent = '';

    const rec = new SR();
    rec.lang = navigator.language || 'es-ES';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.recognition = rec;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r?.isFinal) final += r[0]?.transcript ?? '';
        else interim += r?.[0]?.transcript ?? '';
      }
      this.transcriptEl.textContent = final || interim;
    };

    rec.onend = () => {
      this.isListening = false;
      this.micBtn.classList.remove('listening');
      const query = this.transcriptEl.textContent?.trim();
      if (query && query.length > 1) {
        void this.ask(query);
      } else {
        this.setStatus('Ready');
      }
    };

    rec.onerror = () => {
      this.isListening = false;
      this.micBtn.classList.remove('listening');
      this.setStatus('Mic error — try again');
    };

    rec.start();
  }

  private stopListening(): void {
    this.recognition?.stop();
  }

  private async ask(query: string): Promise<void> {
    this.isProcessing = true;
    this.micBtn.classList.add('processing');
    this.setStatus('Thinking…');
    this.responseEl.textContent = '';

    this.streamAbort?.abort();
    this.streamAbort = new AbortController();

    let fullResponse = '';

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, history: this.history }),
        signal: this.streamAbort.signal,
      });

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      this.setStatus('Speaking…');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          try {
            const evt = JSON.parse(raw);
            if (evt.delta) {
              fullResponse += evt.delta;
              this.responseEl.textContent = fullResponse;
            }
            if (evt.done || evt.error) break;
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        this.responseEl.textContent = 'Error connecting to JARVIS.';
      }
    } finally {
      this.isProcessing = false;
      this.micBtn.classList.remove('processing');
    }

    if (fullResponse) {
      this.history.push({ role: 'user', content: query });
      this.history.push({ role: 'assistant', content: fullResponse });
      if (this.history.length > MAX_HISTORY * 2) {
        this.history = this.history.slice(-MAX_HISTORY * 2);
      }
      this.speak(fullResponse);
    }

    this.setStatus('Ready');
  }

  private speak(text: string): void {
    this.synth.cancel();
    // Strip markdown for cleaner TTS
    const clean = text.replace(/[*_`#>~]/g, '').replace(/\n+/g, ' ').slice(0, 800);
    const utt = new SpeechSynthesisUtterance(clean);
    utt.lang = navigator.language || 'es-ES';
    utt.rate = 1.1;
    utt.pitch = 1.0;
    this.synth.speak(utt);
  }

  private showPanel(msg?: string): void {
    const panel = this.el.querySelector('.jarvis-panel') as HTMLElement;
    panel.hidden = false;
    if (msg) this.responseEl.textContent = msg;
  }

  private closePanel(): void {
    const panel = this.el.querySelector('.jarvis-panel') as HTMLElement;
    panel.hidden = true;
    this.synth.cancel();
    this.streamAbort?.abort();
  }

  private setStatus(s: string): void {
    this.statusEl.textContent = s;
  }
}
