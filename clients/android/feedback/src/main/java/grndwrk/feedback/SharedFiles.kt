package grndwrk.feedback

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/**
 * Hands the file of waiting comments to the app the person shares it with,
 * read only, for as long as that app was given the link. Serves only files
 * in the app's cache under grndwrk/, by their plain name.
 */
class SharedFiles : ContentProvider() {
  private fun file(uri: Uri): File? {
    val name = uri.lastPathSegment ?: return null
    if (!Regex("^grndwrk-feedback-[0-9A-Za-z-]+\\.json$").matches(name)) return null
    val f = File(File(context!!.cacheDir, "grndwrk"), name)
    return if (f.isFile) f else null
  }

  override fun onCreate() = true

  override fun getType(uri: Uri) = if (file(uri) != null) "application/json" else null

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
    if (mode != "r") throw SecurityException("read only")
    return ParcelFileDescriptor.open(file(uri) ?: return null, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
    val f = file(uri) ?: return null
    return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf(f.name, f.length())) }
  }

  override fun insert(uri: Uri, values: ContentValues?) = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = throw UnsupportedOperationException()
}
