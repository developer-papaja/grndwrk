package grndwrk.feedback

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.LocaleList
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/**
 * Speak a comment instead of typing it. Uses Android's speech recognition, on
 * the device when it can. Needs the microphone, which the app asks for the
 * first time Speak is tapped (RECORD_AUDIO, in the package's manifest).
 */
internal class Dictation(private val context: Context) {
  companion object {
    private const val LANGUAGE = "language"

    /** Whether this phone can recognize speech at all. */
    fun available(context: Context): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /** The languages to speak in: the person's preferred ones. */
    val languages: List<Locale>
      get() {
        val list = LocaleList.getDefault()
        val seen = mutableSetOf<String>()
        return (0 until list.size()).map { list[it] }.filter { seen.add(it.toLanguageTag()) }
      }

    var language: Locale
      get() {
        val saved = Env.prefs.getString(LANGUAGE, null)
        return languages.firstOrNull { it.toLanguageTag() == saved } ?: languages.firstOrNull() ?: Locale.getDefault()
      }
      set(value) { Env.prefs.edit().putString(LANGUAGE, value.toLanguageTag()).apply() }
  }

  private var recognizer: SpeechRecognizer? = null
  var running = false
    private set

  /**
   * Listen, and call `heard` with everything recognized so far. `ended` gets
   * a reason when it could not start or stopped by itself on an error, or
   * null when it simply finished.
   */
  fun start(heard: (String) -> Unit, ended: (String?) -> Unit, onDevice: Boolean = true) {
    if (running) return
    if (!available(context)) return ended("Speech recognition is not available on this phone. The keyboard's own mic works meanwhile.")
    val local = onDevice && Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    val r = try {
      if (local) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
    } catch (_: Exception) {
      return ended("Speech recognition is not available right now.")
    }
    recognizer = r
    running = true
    var last: String? = null
    r.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onEvent(eventType: Int, params: Bundle?) {}
      override fun onPartialResults(partialResults: Bundle?) {
        val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
        if (running && !text.isNullOrEmpty()) {
          last = text
          heard(text)
        }
      }
      override fun onResults(results: Bundle?) {
        if (!running) return
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
        if (!text.isNullOrEmpty()) heard(text)
        stop()
        ended(if (text.isNullOrEmpty() && last == null) "Nothing was heard." else null)
      }
      override fun onError(error: Int) {
        if (!running) return
        stop()
        // The language is not on the phone for listening offline: try the phone's usual recognizer.
        if (local && Build.VERSION.SDK_INT >= 31 && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
          return start(heard, ended, onDevice = false)
        }
        ended(
          when (error) {
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "The microphone is off for this app. Turn it on in Settings > Apps > ${Env.appName} > Permissions."
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> if (last == null) "Nothing was heard." else null
            SpeechRecognizer.ERROR_AUDIO -> "The microphone could not start."
            else -> "Speech recognition is not available right now."
          },
        )
      }
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.toLanguageTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    }
    try {
      r.startListening(intent)
    } catch (_: Exception) {
      stop()
      ended("The microphone could not start.")
    }
  }

  fun stop() {
    running = false
    recognizer?.let {
      try {
        it.stopListening()
        it.destroy()
      } catch (_: Exception) {}
    }
    recognizer = null
  }
}
