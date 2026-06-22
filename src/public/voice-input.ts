type SpeechRecognitionInstance = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
};

type SpeechRecognitionResultAlt = { transcript: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  length: number;
  0: SpeechRecognitionResultAlt;
};
type SpeechRecognitionResultList = {
  length: number;
  [index: number]: SpeechRecognitionResult;
};
type SpeechRecognitionResultEvent = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};
type SpeechRecognitionErrorEvent = Event & { error: string };

export function setupVoiceInput(micBtn: HTMLElement, messageInput: HTMLElement) {
  let recognition: SpeechRecognitionInstance | null = null;
  let isRecording = false;

  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      micBtn.style.display = 'none';
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-AU';

    let finalTranscript = '';
    let interimTranscript = '';

    recognition.addEventListener('result', (e: Event) => {
      const ev = e as SpeechRecognitionResultEvent;
      interimTranscript = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) {
          finalTranscript += ev.results[i][0].transcript;
        } else {
          interimTranscript += ev.results[i][0].transcript;
        }
      }
      messageInput.value = finalTranscript + interimTranscript;
      messageInput.dispatchEvent(new Event('input'));
    });

    recognition.addEventListener('end', () => {
      if (isRecording) stopRecording();
    });

    recognition.addEventListener('error', (e: Event) => {
      const ev = e as SpeechRecognitionErrorEvent;
      console.error('[Voice] Error:', ev.error);
      stopRecording();
    });

    micBtn.addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    function startRecording() {
      if (!recognition) return;
      finalTranscript = messageInput.value;
      interimTranscript = '';
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.title = 'Stop recording';
      recognition.start();
      messageInput.focus();
    }

    function stopRecording() {
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.title = 'Voice input';
      try { recognition?.stop(); } catch {}
      messageInput.value = finalTranscript;
      messageInput.dispatchEvent(new Event('input'));
      messageInput.focus();
    }
  } else {
    micBtn.style.display = 'none';
  }
}
