package grndwrk.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotsTest {
  @Test fun digitsDoNotMakeAScreenLookNew() {
    val a = Snapshots.look(listOf("09:00 Bella", "Book a visit") to listOf("search"))
    val b = Snapshots.look(listOf("10:30 Bella", "Book a visit") to listOf("search"))
    assertEquals(a, b)
    assertTrue(a.contains("#:# bella"))
  }

  @Test fun alikeWhenHalfIsShared() {
    assertTrue(Snapshots.alike(setOf("a", "b"), setOf("a", "b", "c")))
    assertFalse(Snapshots.alike(setOf("a", "b"), setOf("c", "d", "a")))
    assertTrue(Snapshots.alike(emptySet(), setOf("x")))
  }
}
