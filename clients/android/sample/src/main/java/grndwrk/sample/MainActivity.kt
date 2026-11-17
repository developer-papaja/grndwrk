package grndwrk.sample

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Opens a screen by the name comments carry, for testing fixes. */
object Screens {
  var current: Activity? = null
  fun open(name: String): Boolean {
    val a = current ?: return false
    return when (name) {
      "Settings", "SettingsActivity" -> { a.startActivity(Intent(a, SettingsActivity::class.java)); true }
      "Appointments", "MainActivity" -> { a.startActivity(Intent(a, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)); true }
      else -> false
    }
  }
}

private val visits = listOf(
  "09:00 Bella, check-up" to "Dr. Lind",
  "09:30 Max, vaccination" to "Dr. Okafor",
  "10:15 Luna, dental" to "Dr. Lind",
  "11:00 Charlie, follow-up" to "Dr. Haddad",
  "13:00 Milo, surgery prep" to "Dr. Okafor",
)

/** A Compose screen: the day's appointments. */
class MainActivity : ComponentActivity() {
  override fun onResume() {
    super.onResume()
    Screens.current = this
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = "Appointments"
    setContent {
      MaterialTheme {
        var search by remember { mutableStateOf("") }
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
          Text("Appointments", style = MaterialTheme.typography.headlineMedium)
          OutlinedTextField(search, { search = it }, label = { Text("Search patients") }, modifier = Modifier.fillMaxWidth().testTag("search"))
          LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
            items(visits.filter { it.first.contains(search, ignoreCase = true) }) { (what, vet) ->
              Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                  Text(what, style = MaterialTheme.typography.titleMedium)
                  Text(vet, style = MaterialTheme.typography.bodyMedium)
                }
              }
            }
          }
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({}, Modifier.testTag("book")) { Text("Book a visit") }
            Spacer(Modifier.weight(1f))
            Button({ startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) }) { Text("Settings") }
          }
        }
      }
    }
  }
}
