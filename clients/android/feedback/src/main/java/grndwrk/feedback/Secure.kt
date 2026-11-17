package grndwrk.feedback

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets kept on this device only, as the iOS package keeps them in the
 * Keychain: the pairing keys, the relay's key, the store's token. Each is
 * sealed with a key in the Android Keystore, which never leaves the device,
 * so a backup restored elsewhere holds nothing that opens.
 */
internal object Secure {
  private const val ALIAS = "grndwrk.feedback"
  private val prefs by lazy { Env.app.getSharedPreferences("grndwrk.feedback.secure", android.content.Context.MODE_PRIVATE) }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  fun get(name: String): String? {
    val stored = prefs.getString(name, null) ?: return null
    return try {
      val all = Base64.decode(stored, Base64.NO_WRAP)
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all.copyOfRange(0, 12)))
      c.updateAAD(name.toByteArray())
      String(c.doFinal(all, 12, all.size - 12))
    } catch (e: Exception) {
      // Restored from another device, or the key was cleared: as if never kept. Any other error
      // may pass (the Keystore busy), so the secret stays for the next try.
      gwLog.error("A kept secret ($name) could not be read: ${e.message}")
      if (e is javax.crypto.AEADBadTagException || e is android.security.keystore.KeyPermanentlyInvalidatedException || e is IllegalArgumentException) prefs.edit().remove(name).apply()
      null
    }
  }

  fun set(name: String, value: String?) {
    if (value == null) return prefs.edit().remove(name).apply()
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    c.updateAAD(name.toByteArray())
    val sealed = c.iv + c.doFinal(value.toByteArray())
    prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }
}
