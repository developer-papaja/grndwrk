package grndwrk.feedback

import android.view.View
import androidx.compose.ui.Modifier
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.semantics

/** The name `Modifier.grndwrkScreen` gives a screen. Only grndwrk reads it: TalkBack and UI tests ignore keys they do not know. */
internal val GrndwrkScreenKey = SemanticsPropertyKey<String>("GrndwrkScreen")

/**
 * Names this screen for grndwrk when it has no title, so comments and
 * pictures from it land on the right screen in the map. It changes nothing
 * the person sees, and nothing TalkBack reads.
 *
 *     PlannerScreen(Modifier.grndwrkScreen("Planner"))
 */
fun Modifier.grndwrkScreen(name: String): Modifier = this.semantics { this[GrndwrkScreenKey] = name }

/**
 * Reads what Jetpack Compose shows, from its semantics tree, the way TalkBack
 * does. Loaded only when the app has Compose: everything Compose is in this file.
 */
internal object ComposeSemantics {
  /** Whether this view hosts Compose content whose semantics can be read. */
  fun isComposeView(view: View): Boolean = view is RootForTest

  /** The merged nodes (what TalkBack reads) as elements, and the unmerged ones as boxes. */
  fun collect(view: View, out: MutableList<Inspector.Node>, given: MutableList<Pair<String, android.graphics.Rect>>) {
    val owner = (view as? RootForTest)?.semanticsOwner ?: return
    var visited = 0
    fun element(node: SemanticsNode, depth: Int) {
      visited++
      if (depth > 60 || visited > 8000) return
      val c = node.config
      val frame = rect(node) ?: return
      if (!node.isRoot) {
        val role = c.getOrNull(SemanticsProperties.Role)
        val editable = c.contains(SemanticsProperties.EditableText) || c.contains(SemanticsActions.SetText)
        val description = c.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ")
        val text = c.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }
        val clickable = c.contains(SemanticsActions.OnClick)
        // A field's value is what was typed in it: never its label. Its label is in Text.
        val label = Inspector.clean(description) ?: Inspector.clean(text)
        val tag = Inspector.clean(c.getOrNull(SemanticsProperties.TestTag))
        val says = label != null || clickable || editable || role != null
        if (says) {
          out += Inspector.Node(
            frame, label, tag, roleOf(role, editable, c.contains(SemanticsProperties.Heading), clickable, text != null),
            element = true, textEntry = editable, tab = role == Role.Tab,
          )
        }
      }
      for (child in node.children) element(child, depth + 1)
    }
    element(owner.rootSemanticsNode, 0)

    visited = 0
    // The unmerged tree: cards, rows and other containers the eye sees as boxes, and names given with grndwrkScreen.
    fun box(node: SemanticsNode, depth: Int) {
      visited++
      if (depth > 60 || visited > 8000) return
      val frame = rect(node) ?: return
      node.config.getOrNull(GrndwrkScreenKey)?.let { name -> Inspector.clean(name)?.let { given += it to frame } }
      if (!node.isRoot) out += Inspector.Node(frame, null, Inspector.clean(node.config.getOrNull(SemanticsProperties.TestTag)), "area", element = false)
      for (child in node.children) box(child, depth + 1)
    }
    box(owner.unmergedRootSemanticsNode, 0)
  }

  private fun rect(node: SemanticsNode): android.graphics.Rect? {
    val b = node.boundsInWindow
    if (b.width <= 0f || b.height <= 0f) return null
    return android.graphics.Rect(b.left.toInt(), b.top.toInt(), b.right.toInt(), b.bottom.toInt())
  }

  private fun roleOf(role: Role?, editable: Boolean, heading: Boolean, clickable: Boolean, text: Boolean): String = when {
    role == Role.Button -> "button"
    role == Role.Checkbox -> "checkbox"
    role == Role.Switch -> "switch"
    role == Role.RadioButton -> "radio button"
    role == Role.Tab -> "tab"
    role == Role.Image -> "image"
    role == Role.DropdownList -> "pop-up button"
    editable -> "text field"
    heading -> "heading"
    clickable -> "button"
    text -> "text"
    else -> "element"
  }
}
