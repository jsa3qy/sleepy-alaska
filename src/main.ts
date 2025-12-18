import L from 'leaflet';
import * as yaml from 'js-yaml';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';

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

function renderLegend(
  categories: Category[],
  activeCategoriesSet: Set<string>,
  onToggleCategory: (categoryName: string) => void
): void {
  const legendEl = document.getElementById('legend')!;

  const title = document.createElement('h3');
  title.textContent = 'Legend';
  legendEl.appendChild(title);

  categories.forEach(category => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.category = category.name;

    const colorBox = document.createElement('div');
    colorBox.className = 'legend-color';
    colorBox.style.backgroundColor = category.color;

    const label = document.createElement('span');
    label.textContent = category.name;

    item.appendChild(colorBox);
    item.appendChild(label);

    // Add click handler
    item.addEventListener('click', () => {
      onToggleCategory(category.name);

      // Toggle visual state
      if (activeCategoriesSet.has(category.name)) {
        item.classList.remove('inactive');
      } else {
        item.classList.add('inactive');
      }
    });

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

    // Track active categories (all active by default)
    const activeCategories = new Set<string>(config.categories.map(c => c.name));

    // Store all markers by category
    const markersByCategory = new Map<string, { cluster: L.Marker; normal: L.Marker }[]>();
    config.categories.forEach(cat => {
      markersByCategory.set(cat.name, []);
    });

    // Create both clustered and non-clustered groups
    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
    });

    const normalGroup = L.layerGroup();

    // Create all markers and organize by category
    config.pins.forEach(pin => {
      const color = categoryColors.get(pin.category) || '#gray';
      const icon = createCustomIcon(color);

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

      // Create markers for both groups
      const clusterMarker = L.marker(pin.coordinates, { icon });
      clusterMarker.bindPopup(popupContent);

      const normalMarker = L.marker(pin.coordinates, { icon });
      normalMarker.bindPopup(popupContent);

      // Store markers by category
      const categoryMarkers = markersByCategory.get(pin.category) || [];
      categoryMarkers.push({ cluster: clusterMarker, normal: normalMarker });
      markersByCategory.set(pin.category, categoryMarkers);
    });

    // Function to update visible markers based on active categories
    function updateVisibleMarkers() {
      // Clear both groups
      clusterGroup.clearLayers();
      normalGroup.clearLayers();

      // Add markers from active categories
      activeCategories.forEach(category => {
        const markers = markersByCategory.get(category) || [];
        markers.forEach(({ cluster, normal }) => {
          clusterGroup.addLayer(cluster);
          normalGroup.addLayer(normal);
        });
      });
    }

    // Initialize with all markers visible
    updateVisibleMarkers();

    // Start with clustering off (based on user's preference)
    let clusteringEnabled = false;
    map.addLayer(normalGroup);

    // Toggle functionality
    const toggleButton = document.getElementById('cluster-toggle')!;
    const toggleSwitch = document.getElementById('toggle-switch')!;

    toggleButton.addEventListener('click', () => {
      clusteringEnabled = !clusteringEnabled;

      if (clusteringEnabled) {
        map.removeLayer(normalGroup);
        map.addLayer(clusterGroup);
        toggleSwitch.classList.add('active');
      } else {
        map.removeLayer(clusterGroup);
        map.addLayer(normalGroup);
        toggleSwitch.classList.remove('active');
      }
    });

    // Category toggle handler
    function toggleCategory(categoryName: string) {
      if (activeCategories.has(categoryName)) {
        activeCategories.delete(categoryName);
      } else {
        activeCategories.add(categoryName);
      }
      updateVisibleMarkers();
    }

    // Render legend with click handlers
    renderLegend(config.categories, activeCategories, toggleCategory);

  } catch (error) {
    console.error('Failed to initialize map:', error);
    alert('Failed to load map configuration. Please check the console for details.');
  }
}

// Initialize when DOM is ready
initMap();
