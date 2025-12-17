# Sleepy Alaska

A dynamic map powered by static YAML configuration, perfect for GitHub Pages.

## Features

- Interactive map using Leaflet.js
- Pin locations defined in `pins.yaml`
- Color-coded categories with legend
- Support for descriptions and external links
- Fully static - no backend required

## Development

Install dependencies:
```bash
npm install
```

Run development server:
```bash
npm run dev
```

Build for production:
```bash
npm run build
```

## Deployment to GitHub Pages

1. Build the project:
   ```bash
   npm run build
   ```

2. The built files will be in the `dist/` directory

3. Deploy to GitHub Pages:
   - Go to your repository settings on GitHub
   - Navigate to "Pages" section
   - Select "Deploy from a branch"
   - Choose the `gh-pages` branch (or configure GitHub Actions)

### Using GitHub Actions (Recommended)

Create `.github/workflows/deploy.yml` to automatically build and deploy on push to main.

## Configuration

Edit `pins.yaml` to add or modify pins:

```yaml
pins:
  - name: "Location Name"
    coordinates: [latitude, longitude]
    description: "Description text"
    category: "Category Name"
    link: "https://optional-link.com"
```

Add or modify categories in the same file:

```yaml
categories:
  - name: "Category Name"
    color: "#hexcolor"
```
