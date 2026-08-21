const express = require('express')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 5175
const DIST_DIR = path.join(__dirname, 'dist')

// Serve static files
app.use(express.static(DIST_DIR))

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})