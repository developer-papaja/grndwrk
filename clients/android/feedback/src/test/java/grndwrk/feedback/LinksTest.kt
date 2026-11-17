package grndwrk.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinksTest {
  private val mailbox = "0123456789abcdef0123456789abcdef"
  private val secret = "ab".repeat(32)

  @Test fun readsAnInvite() {
    assertEquals(Triple("https://relay.example.workers.dev", mailbox, secret), Relay.parse("  grndwrk:invite/relay.example.workers.dev/$mailbox/$secret\n"))
    assertEquals("http://localhost:8787", Relay.parse("grndwrk:invite/localhost:8787/$mailbox/$secret")?.first)
  }

  @Test fun refusesWhatIsNoInvite() {
    assertNull(Relay.parse("https://relay.example/$mailbox/$secret"))
    assertNull(Relay.parse("grndwrk:invite/Relay.Example/$mailbox/$secret"))
    assertNull(Relay.parse("grndwrk:invite/relay.example/$mailbox/${secret.uppercase()}"))
    assertNull(Relay.parse("grndwrk:invite/relay.example:123456/$mailbox/$secret"))
    assertNull(Relay.parse("grndwrk:invite/relay.example/$mailbox/$secret/more"))
  }

  @Test fun readsAStoreLink() {
    assertEquals("https://store.example/clinic/" to "tok_12345678", Store.parse("grndwrk:store/store.example/clinic#tok_12345678"))
    assertEquals("http://localhost:8788/" to "abcdefgh", Store.parse("grndwrk:store/localhost:8788#abcdefgh"))
  }

  @Test fun refusesWhatIsNoStoreLink() {
    assertNull(Store.parse("grndwrk:store/store.example/clinic"))
    assertNull(Store.parse("grndwrk:store/store.example/../x#abcdefgh"))
    assertNull(Store.parse("grndwrk:store/store.example/clinic#short"))
    assertNull(Store.parse("grndwrk:store/st ore.example/clinic#abcdefgh"))
  }

  @Test fun knowsACommenter() {
    assertEquals(true, Store.isCommenter("dev_frontdesk1"))
    assertEquals(false, Store.isCommenter("short"))
    assertEquals(false, Store.isCommenter("../../etc"))
  }
}
