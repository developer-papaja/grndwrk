package grndwrk.feedback

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The hashes, HMACs and sealing the iOS package does with CryptoKit, the same
 * bytes in and out: plain Java, so it runs in unit tests on the Mac too.
 */
internal object Crypto {
  private val random = SecureRandom()

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

  fun bytes(hex: String): ByteArray? {
    if (hex.length % 2 != 0 || !hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
    return ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }

  fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

  fun sha256Hex(text: String): String = hex(sha256(text.toByteArray()))

  /** HMAC-SHA256 keyed by the key's text (its hex as written, not the bytes), as everywhere in grndwrk. */
  fun hmac(key: String, message: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
    return mac.doFinal(message)
  }

  fun hmacHex(key: String, message: String): String = hex(hmac(key, message.toByteArray()))

  /** Random bytes as lower-case hex. */
  fun randomHex(bytes: Int): String = hex(ByteArray(bytes).also { random.nextBytes(it) })

  /** AES-256-GCM with `context` bound in as associated data: nonce (12), ciphertext and tag (16) in a row, as CryptoKit's `combined`. */
  fun seal(plain: ByteArray, key: ByteArray, context: String): ByteArray {
    val nonce = ByteArray(12).also { random.nextBytes(it) }
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    c.updateAAD(context.toByteArray())
    return nonce + c.doFinal(plain)
  }

  fun open(sealed: ByteArray, key: ByteArray, context: String): ByteArray? {
    if (sealed.size < 12 + 16) return null
    return try {
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
      c.updateAAD(context.toByteArray())
      c.doFinal(sealed, 12, sealed.size - 12)
    } catch (_: Exception) {
      null
    }
  }
}
