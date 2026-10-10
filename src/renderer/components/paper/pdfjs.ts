import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Set once for every renderer view that opens a PDF (the PDF viewer and the text tab).
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }
