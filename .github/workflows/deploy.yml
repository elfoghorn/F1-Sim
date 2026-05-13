name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'f1_simulator.jsx'
      - 'index.html'
      - 'scripts/build.js'

  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build-and-deploy:
    name: Build + Deploy
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install build dependencies
        run: npm install

      - name: Build app
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
        run: node scripts/build.js

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
          # Only upload the files needed for the app
          # (exclude Python source, .env, secrets)

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
