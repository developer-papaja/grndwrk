package grndwrk.sample

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView

/** A Views screen: the clinic's settings. */
class SettingsActivity : Activity() {
  override fun onResume() {
    super.onResume()
    Screens.current = this
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pad = (16 * resources.displayMetrics.density).toInt()
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
    root.addView(TextView(this).apply { text = "Clinic name"; textSize = 14f })
    root.addView(EditText(this).apply { setText("Riverside Vet Clinic"); contentDescription = null; id = android.R.id.edit })
    root.addView(Switch(this).apply { text = "Send reminders by text"; isChecked = true })
    root.addView(Switch(this).apply { text = "Allow online booking" })
    // Hidden from TalkBack but still drawn, as content behind an open drawer is: its field must
    // still be drawn empty in every picture (security audit run-4).
    val hidden = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    hidden.addView(TextView(this).apply { text = "Front desk notes"; textSize = 14f })
    hidden.addView(EditText(this).apply { setText("blank-me-123") })
    root.addView(hidden)
    root.addView(Button(this).apply { text = "Save"; contentDescription = "Save settings" })
    setContentView(root, LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
  }
}
