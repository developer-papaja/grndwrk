package grndwrk.feedback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The phone's keys, sealing and signing must match grndwrk byte for byte.
 * The expected values come from src/relay/keys.ts, src/relay/sync.ts,
 * src/server/devices.ts and src/server/pairing.ts, run with the same inputs.
 */
class KeysTest {
  private val key = "0123456789abcdef".repeat(4)

  @Test fun relayKeysMatchKeysTs() {
    assertEquals("471c8fa4daa2a47ccb6ae03a285861e52be5c40ec5241da9264d365859822bd6", Relay.signKey(key))
    assertEquals("8eeecfc78d713888826c7367298849c9f9021ef92470f46f036fd9c9c4fb38c0", Relay.sealKey(key))
    assertEquals("35c2b3cdfc850ba705d217e971fdd88d", Relay.deviceId(key))
    assertEquals("5203", Relay.digits(key))
    assertEquals("b945c94bb8b25a3481b51ed50d5c890d", Crypto.sha256Hex("grndwrk-invite:$key").take(32))
  }

  @Test fun opensWhatKeysTsSealed() {
    val sealed = Crypto.bytes("ac3ffba11935a09de1a1f80d340851fe82ac17013504b42dbca9064ccc05d755b8b1008348d48170481f6585fc48d5e1650a")!!
    val context = "outbox:${Relay.deviceId(key)}"
    val plain = Relay.open(sealed, Relay.sealKey(key), context)
    assertNotNull(plain)
    assertEquals(5, JSONObject(String(plain!!)).getInt("at"))
    // Bound to its place: anywhere else it does not open.
    assertNull(Relay.open(sealed, Relay.sealKey(key), "inbox:${Relay.deviceId(key)}"))
  }

  @Test fun sealsWhatOpensAgain() {
    val sealed = Relay.seal("hello".toByteArray(), Relay.sealKey(key), "inbox:x")!!
    assertEquals(12 + 5 + 16, sealed.size)
    assertEquals("hello", String(Relay.open(sealed, Relay.sealKey(key), "inbox:x")!!))
    assertNull(Relay.seal("x".toByteArray(), "not hex", "inbox:x"))
  }

  @Test fun pairingMatchesTheServer() {
    assertEquals("d4864f921a05a67040649987d20b132b", Pairing.deviceId(key))
    assertEquals("ebd0128c62f9e5a7ee609ce645ec003e775aa4251fb81b6dfa7675b56ac39123", Pairing.proof(key, "ABC123"))
    assertEquals("0860", Pairing.checkDigits("secret-1"))
    val line = Relay.requestLine("post", "/api/feedback", "1700000000000", "NONCE", """{"a":1}""".toByteArray())
    assertEquals("ee3105bd56d408a5aa8783acf17bb78f629f1381e4ca66fa1431ec1a74e277f7", Crypto.hmacHex(key, line))
  }
}
