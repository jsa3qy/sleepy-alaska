import L from 'leaflet';
import * as yaml from 'js-yaml';
import 'leaflet/dist/leaflet.css';

// Fix for default marker icons in Leaflet with bundlers
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface Category {
  name: string;
  color: string;
}

interface Pin {
  name: string;
  coordinates: [number, number];
  description: string;
  category: string;
  link?: string;
  maps_link?: string;
}

interface MapConfig {
  map: {
    center: [number, number];
    zoom: number;
  };
  categories: Category[];
  pins: Pin[];
}

async function loadConfig(): Promise<MapConfig> {
  const response = await fetch('./pins.yaml');
  const text = await response.text();
  return yaml.load(text) as MapConfig;
}

function createCustomIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="marker-pin" style="--marker-color: ${color}">
      <div class="marker-dot"></div>
      <div class="marker-pulse"></div>
    </div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42],
    popupAnchor: [0, -42],
  });
}

function renderLegend(categories: Category[]): void {
  const legendEl = document.getElementById('legend')!;

  const title = document.createElement('h3');
  title.textContent = 'Legend';
  legendEl.appendChild(title);

  categories.forEach(category => {
    const item = document.createElement('div');
    item.className = 'legend-item';

    const colorBox = document.createElement('div');
    colorBox.className = 'legend-color';
    colorBox.style.backgroundColor = category.color;

    const label = document.createElement('span');
    label.textContent = category.name;

    item.appendChild(colorBox);
    item.appendChild(label);
    legendEl.appendChild(item);
  });
}

async function initMap(): Promise<void> {
  try {
    const config = await loadConfig();

    // Initialize map
    const map = L.map('map').setView(config.map.center, config.map.zoom);

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    // Create category color map
    const categoryColors = new Map<string, string>();
    config.categories.forEach(cat => {
      categoryColors.set(cat.name, cat.color);
    });

    // Add pins to map
    config.pins.forEach(pin => {
      const color = categoryColors.get(pin.category) || '#gray';
      const icon = createCustomIcon(color);

      const marker = L.marker(pin.coordinates, { icon }).addTo(map);

      // Create popup content
      let popupContent = `<strong>${pin.name}</strong><br>${pin.description}`;

      const links: string[] = [];
      if (pin.link) {
        links.push(`<a href="${pin.link}" target="_blank">Learn more</a>`);
      }
      if (pin.maps_link) {
        links.push(`<a href="${pin.maps_link}" target="_blank">View on map</a>`);
      }

      if (links.length > 0) {
        popupContent += `<br>${links.join(' • ')}`;
      }

      marker.bindPopup(popupContent);
    });

    // Render legend
    renderLegend(config.categories);

  } catch (error) {
    console.error('Failed to initialize map:', error);
    alert('Failed to load map configuration. Please check the console for details.');
  }
}

// Initialize when DOM is ready
initMap();
