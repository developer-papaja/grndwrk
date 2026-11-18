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
   *
   * Three ways, each tried when the one before fails before anything was heard:
   * the phone's offline recognizer, the usual one preferring offline, then the
   * usual one online. Only then does it say why, in words a person can act on.
   */
  fun start(heard: (String) -> Unit, ended: (String?) -> Unit, online: () -> Unit = {}, attempt: Int = 0) {
    if (running) return
    if (!available(context)) return ended("This phone has no speech recognition, or it is turned off. The keyboard's own mic works meanwhile.")
    val onDevice = attempt == 0 && Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    if (attempt == 0 && !onDevice) return start(heard, ended, online, 1)
    val preferOffline = attempt <= 1
    // The last way sends the audio to the phone's speech service: the person is told.
    if (!preferOffline) online()
    val r = try {
      if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
    } catch (e: Exception) {
      gwLog.error("Speech recognizer ${attempt + 1} could not be made: ${e.message}")
      return if (attempt < 2) start(heard, ended, online, attempt + 1) else ended(why(-1))
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
        gwLog.info("Speech recognizer ${attempt + 1} of 3 stopped with error $error")
        val final = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS || error == SpeechRecognizer.ERROR_NO_MATCH ||
          error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_AUDIO
        // Nothing heard yet, and another way may work: try it before saying anything.
        if (!final && last == null && attempt < 2) return start(heard, ended, online, attempt + 1)
        ended(if ((error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) && last != null) null else why(error))
      }
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.toLanguageTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
    }
    try {
      r.startListening(intent)
    } catch (e: Exception) {
      stop()
      gwLog.error("Speech recognizer ${attempt + 1} could not start: ${e.message}")
      if (attempt < 2) start(heard, ended, online, attempt + 1) else ended("The microphone could not start.")
    }
  }

  /** Why speaking stopped, in words a person can act on. The error number goes to the log too. */
  private fun why(error: Int): String {
    val name = language.getDisplayName(language).replaceFirstChar { it.titlecase(language) }
    return when (error) {
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "The microphone is off for this app. Turn it on in Settings > Apps > ${Env.appName} > Permissions."
      SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Nothing was heard."
      SpeechRecognizer.ERROR_AUDIO -> "The microphone could not start."
      SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech in $name needs the internet here, and none was reached. Download $name for offline speech in the phone's settings, or try again online."
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Something else is listening, maybe the keyboard's mic. Stop it and try again."
      SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "The phone's speech service is busy. Try again in a minute."
      SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "The phone's speech service did not answer. Try again in a moment."
      SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
        "Speech in $name is not on this phone. Pick another language with the language button, or add $name in the phone's speech settings."
      SpeechRecognizer.ERROR_CLIENT -> "The phone's speech service could not start. Check that it is turned on: in Settings, search for \"speech\". The keyboard's own mic works meanwhile."
      else -> "Speaking did not work here (Android's error ${if (error < 0) "on start" else error}). The keyboard's own mic works meanwhile."
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
