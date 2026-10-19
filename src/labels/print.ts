// Printing box labels: the API returns a whole printable page (sized for the
// label printer with @page); it opens in a new window and the print dialog
// follows. The window is opened before the request so pop-up blockers allow it.

/** Opens a blank window now (inside the click) and returns a function that fills and prints it. */
export function printWindow(): { fill: (html: string) => void; close: () => void } {
  const w = window.open('', '_blank')
  return {
    fill(html: string) {
      if (!w) {
        // Pop-ups blocked: fall back to a download the browser can open and print.
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        const a = document.createElement('a')
        a.href = url
        a.download = 'box-labels.html'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        return
      }
      w.document.open()
      w.document.write(html)
      w.document.close()
      w.focus()
      // Give the QR drawings a moment to lay out before the dialog.
      setTimeout(() => w.print(), 300)
    },
    close() {
      w?.close()
    },
  }
}
