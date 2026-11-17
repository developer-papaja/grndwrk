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
    root.addView(Button(this).apply { text = "Save"; contentDescription = "Save settings" })
    setContentView(root, LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
  }
}
