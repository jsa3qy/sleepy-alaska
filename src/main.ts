import L from 'leaflet';
import * as yaml from 'js-yaml';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import 'leaflet-routing-machine';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';

// Supabase configuration - replace with your project values
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let supabase: SupabaseClient | null = null;

// Initialize Supabase if configured
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// GPX parsing - fetches local GPX files and extracts coordinates
async function fetchAndParseGPX(url: string): Promise<[number, number][]> {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const gpxText = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxText, 'text/xml');
    const coordinates: [number, number][] = [];

    let trackPoints = doc.querySelectorAll('trkpt');
    if (trackPoints.length === 0) trackPoints = doc.querySelectorAll('rtept');
    if (trackPoints.length === 0) trackPoints = doc.querySelectorAll('wpt');

    trackPoints.forEach(point => {
      const lat = parseFloat(point.getAttribute('lat') || '0');
      const lng = parseFloat(point.getAttribute('lon') || '0');
      if (lat !== 0 && lng !== 0) {
        coordinates.push([lat, lng]);
      }
    });

    return coordinates;
  } catch (error) {
    console.error('Error fetching/parsing GPX:', error);
    return [];
  }
}

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
  id: string;
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
  extended_description?: string;
  cost?: string;
  tips?: string;
  photos?: string[];
  distance?: number;        // in miles (for hikes)
  elevation_gain?: number;  // in feet (for hikes)
  gpx?: string;             // GPX filename for hike routes
}

interface MapConfig {
  map: {
    center: [number, number];
    zoom: number;
  };
  categories: Category[];
  pins: Pin[];
}

// Database row types from Supabase
interface DbCategory {
  id: string;
  name: string;
  color: string;
}

interface DbPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
  category_id: string;
  link: string | null;
  maps_link: string | null;
  extended_description: string | null;
  cost: string | null;
  tips: string | null;
  photos: string[] | null;
  distance: number | null;
  elevation_gain: number | null;
  gpx: string | null;
}

interface DbMapConfig {
  center_lat: number;
  center_lng: number;
  zoom: number;
}

async function loadConfig(): Promise<MapConfig> {
  // If Supabase is configured, load from database
  if (supabase) {
    const [categoriesRes, pinsRes, configRes] = await Promise.all([
      supabase.from('categories').select('*'),
      supabase.from('pins').select('*'),
      supabase.from('map_config').select('*').limit(1).single()
    ]);

    if (categoriesRes.error) throw new Error(`Failed to load categories: ${categoriesRes.error.message}`);
    if (pinsRes.error) throw new Error(`Failed to load pins: ${pinsRes.error.message}`);
    if (configRes.error) throw new Error(`Failed to load map config: ${configRes.error.message}`);

    const dbCategories = categoriesRes.data as DbCategory[];
    const dbPins = pinsRes.data as DbPin[];
    const dbConfig = configRes.data as DbMapConfig;

    // Build category lookup
    const categoryMap = new Map<string, string>();
    dbCategories.forEach(c => categoryMap.set(c.id, c.name));

    // Transform to app format
    const categories: Category[] = dbCategories.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color
    }));

    const pins: Pin[] = dbPins.map(p => ({
      name: p.name,
      coordinates: [p.lat, p.lng] as [number, number],
      description: p.description,
      category: categoryMap.get(p.category_id) || 'Unknown',
      link: p.link || undefined,
      maps_link: p.maps_link || undefined,
      extended_description: p.extended_description || undefined,
      cost: p.cost || undefined,
      tips: p.tips || undefined,
      photos: p.photos || undefined,
      distance: p.distance || undefined,
      elevation_gain: p.elevation_gain || undefined,
      gpx: p.gpx || undefined
    }));

    return {
      map: {
        center: [dbConfig.center_lat, dbConfig.center_lng],
        zoom: dbConfig.zoom
      },
      categories,
      pins
    };
  }

  // Fallback to YAML file (for local dev without Supabase)
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
    iconAnchor: [15, 30],
    popupAnchor: [0, -30],
  });
}

function renderLegend(
  categories: Category[],
  activeCategoriesSet: Set<string>,
  onToggleCategory: (categoryName: string) => void
): void {
  const legendEl = document.getElementById('legend')!;

  // Create legend header with hide button
  const header = document.createElement('div');
  header.className = 'legend-header';

  const title = document.createElement('h3');
  title.textContent = 'Legend';

  const hideBtn = document.createElement('button');
  hideBtn.className = 'legend-hide-btn';
  hideBtn.innerHTML = '&times;';
  hideBtn.id = 'legend-hide-btn';

  header.appendChild(title);
  header.appendChild(hideBtn);
  legendEl.appendChild(header);

  categories.forEach(category => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.category = category.name;

    const itemContent = document.createElement('div');
    itemContent.className = 'legend-item-content';

    // Add checkbox indicator (shows category color when active)
    const checkbox = document.createElement('div');
    checkbox.className = 'legend-checkbox';
    checkbox.style.backgroundColor = category.color;
    checkbox.style.borderColor = category.color;

    const label = document.createElement('span');
    label.textContent = category.name;

    itemContent.appendChild(checkbox);
    itemContent.appendChild(label);
    item.appendChild(itemContent);

    // Add hike mode button for Hike category
    if (category.name === 'Hike') {
      const hikeModeBtn = document.createElement('button');
      hikeModeBtn.className = 'hike-mode-btn';
      hikeModeBtn.textContent = 'Filter';
      hikeModeBtn.id = 'hike-mode-btn';
      item.appendChild(hikeModeBtn);
    }

    // Set initial state
    if (!activeCategoriesSet.has(category.name)) {
      item.classList.add('inactive');
    }

    // Add click handler (only for the content, not the hike mode button)
    itemContent.addEventListener('click', () => {
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

    // Initialize map with double-tap zoom enabled for mobile
    const map = L.map('map', {
      doubleClickZoom: true,
      tapTolerance: 15
    }).setView(config.map.center, config.map.zoom);

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

    // Track active categories (all active by default except "Mountain Peak")
    const activeCategories = new Set<string>(
      config.categories
        .filter(c => c.name !== 'Mountain Peak')
        .map(c => c.name)
    );

    // Parse URL query parameters to override initial category selection
    const urlParams = new URLSearchParams(window.location.search);
    const categoriesParam = urlParams.get('categories');

    if (categoriesParam) {
      // Clear default selection
      activeCategories.clear();

      // Parse comma-separated category names (URLSearchParams automatically decodes + as space)
      const requestedCategories = categoriesParam.split(',').map(c => c.trim());

      // Only add categories that actually exist in the config (case-insensitive matching)
      requestedCategories.forEach(catName => {
        const matchedCategory = config.categories.find(c => c.name.toLowerCase() === catName.toLowerCase());
        if (matchedCategory) {
          activeCategories.add(matchedCategory.name); // Use the correctly-cased name from config
        } else {
          console.warn(`Category "${catName}" from URL not found in config`);
        }
      });
    }

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

    // Hike mode state (declare early before updateVisibleMarkers is called)
    let hikeModeActive = false;
    let currentMinDistance = 0;
    let currentMaxDistance = 100;
    let currentMinElevation = 0;
    let currentMaxElevation = 10000;
    let preHikeModeCategories: Set<string> | null = null;

    // Routing state
    let routingControl: L.Routing.Control | null = null;

    // Hike GPX routes - displayed when hike category is visible
    const hikeRoutesLayer = L.layerGroup().addTo(map);

    // Load all hike GPX routes (permanently shown when Hike category is visible)
    async function updateHikeRoutes() {
      hikeRoutesLayer.clearLayers();

      // Only show routes when Hike category is active
      if (!activeCategories.has('Hike')) return;

      // Load all GPX routes for hikes that have them
      const hikePins = config.pins.filter(pin => pin.category === 'Hike' && pin.gpx);

      for (const pin of hikePins) {
        const coordinates = await fetchAndParseGPX(`./gpx/${pin.gpx}`);
        if (coordinates.length > 0) {
          L.polyline(coordinates, {
            color: '#ff3333',
            weight: 3,
            opacity: 0.7,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(hikeRoutesLayer);
        }
      }
    }

    // Store markers with their data for later reference
    const markerDataMap = new Map<L.Marker, Pin>();
    // Store markers by pin name for search functionality
    const pinMarkers = new Map<string, L.Marker>();

    // Create all markers and organize by category
    config.pins.forEach(pin => {
      const color = categoryColors.get(pin.category) || '#gray';
      const icon = createCustomIcon(color);

      // Create popup content
      let popupContent = `<strong>${pin.name}</strong><br>${pin.description}`;

      // Add cost for Tourist Activity pins
      if (pin.cost) {
        popupContent += `<br><strong>Cost:</strong> ${pin.cost}`;
      }

      // Add tips if available
      if (pin.tips) {
        popupContent += `<br><strong>Time:</strong> ${pin.tips}`;
      }

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

      // Map markers to pin data (do this immediately when creating markers)
      markerDataMap.set(clusterMarker, pin);
      markerDataMap.set(normalMarker, pin);

      // Store marker reference by pin name for search
      pinMarkers.set(pin.name, clusterMarker);
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
          let shouldAddMarker = true;

          // If in hike mode and this is a hike, apply filters
          if (hikeModeActive && category === 'Hike') {
            const pin = markerDataMap.get(cluster);

            if (pin && pin.distance && pin.elevation_gain) {
              const passesDistanceFilter = pin.distance >= currentMinDistance && pin.distance <= currentMaxDistance;
              const passesElevationFilter = pin.elevation_gain >= currentMinElevation && pin.elevation_gain <= currentMaxElevation;

              if (!passesDistanceFilter || !passesElevationFilter) {
                shouldAddMarker = false;
              }
            }
          }

          if (shouldAddMarker) {
            clusterGroup.addLayer(cluster);
            normalGroup.addLayer(normal);
          }
        });
      });
    }

    // Initialize with all markers visible
    updateVisibleMarkers();

    // Load hike GPX routes
    updateHikeRoutes();

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

    // Side panel functionality
    const sidePanel = document.getElementById('side-panel')!;
    const panelContent = document.getElementById('panel-content')!;
    const panelToggle = document.getElementById('panel-toggle')!;
    const panelClose = document.getElementById('panel-close')!;
    const mapElement = document.getElementById('map')!;

    // Populate side panel with location cards
    function renderSidePanel() {
      panelContent.innerHTML = '';

      config.pins.forEach((pin) => {
        // Skip if category is not active
        if (!activeCategories.has(pin.category)) return;

        // If in hike mode, apply distance/elevation filters
        if (hikeModeActive && pin.category === 'Hike') {
          if (pin.distance && pin.elevation_gain) {
            const passesDistanceFilter = pin.distance >= currentMinDistance && pin.distance <= currentMaxDistance;
            const passesElevationFilter = pin.elevation_gain >= currentMinElevation && pin.elevation_gain <= currentMaxElevation;
            if (!passesDistanceFilter || !passesElevationFilter) {
              return;
            }
          }
        }

        const card = document.createElement('div');
        card.className = 'location-card';
        card.dataset.pinName = pin.name;

        const color = categoryColors.get(pin.category) || '#gray';

        let cardHTML = `
          <div class="card-header">
            <div class="card-category-dot" style="background-color: ${color}"></div>
            <div class="card-title">
              <h3>${pin.name}</h3>
              <div class="card-category-name">${pin.category}</div>
            </div>
          </div>
          <div class="card-description">${pin.description}</div>
        `;

        if (pin.extended_description) {
          cardHTML += `<div class="card-extended">${pin.extended_description}</div>`;
        }

        if (pin.cost || pin.tips) {
          cardHTML += '<div class="card-meta">';
          if (pin.cost) {
            cardHTML += `<div class="card-meta-item"><span class="card-meta-label">Cost:</span> ${pin.cost}</div>`;
          }
          if (pin.tips) {
            cardHTML += `<div class="card-meta-item"><span class="card-meta-label">Tips:</span> ${pin.tips}</div>`;
          }
          cardHTML += '</div>';
        }

        cardHTML += '<div class="card-actions">';
        cardHTML += '<button class="card-button card-button-primary view-on-map-btn">View on Map</button>';
        if (pin.link) {
          cardHTML += `<a href="${pin.link}" target="_blank" class="card-button card-button-secondary">Learn More</a>`;
        }
        if (pin.maps_link) {
          cardHTML += `<a href="${pin.maps_link}" target="_blank" class="card-button card-button-secondary">Directions</a>`;
        }
        cardHTML += '</div>';

        card.innerHTML = cardHTML;

        // Click handler for "View on Map" button
        const viewOnMapBtn = card.querySelector('.view-on-map-btn') as HTMLButtonElement;
        viewOnMapBtn.addEventListener('click', (e) => {
          e.stopPropagation();

          // Find the marker for this pin by matching coordinates
          const markers = markersByCategory.get(pin.category) || [];
          const markerPair = markers.find(m => {
            const markerLatLng = m.normal.getLatLng();
            return markerLatLng.lat === pin.coordinates[0] && markerLatLng.lng === pin.coordinates[1];
          });

          if (markerPair) {
            const marker = clusteringEnabled ? markerPair.cluster : markerPair.normal;

            // Zoom to marker location with smooth animation
            map.flyTo(pin.coordinates, 12, {
              duration: 1.2,
              easeLinearity: 0.25
            });

            // Open popup after animation starts
            setTimeout(() => {
              marker.openPopup();
            }, 600);

            // Highlight card
            document.querySelectorAll('.location-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
          } else {
            console.error('Could not find marker for pin:', pin.name);
          }
        });

        // Click handler for entire card
        card.addEventListener('click', () => {
          const viewEvent = new MouseEvent('click', { bubbles: true });
          viewOnMapBtn.dispatchEvent(viewEvent);
        });

        panelContent.appendChild(card);
      });
    }

    // Initial render
    renderSidePanel();

    // Category toggle handler
    function toggleCategory(categoryName: string) {
      if (activeCategories.has(categoryName)) {
        activeCategories.delete(categoryName);
      } else {
        activeCategories.add(categoryName);
      }
      updateVisibleMarkers();
      renderSidePanel(); // Update side panel when categories change

      // Update hike routes when Hike category changes
      if (categoryName === 'Hike') {
        updateHikeRoutes();
      }
    }

    // Render legend with click handlers
    renderLegend(config.categories, activeCategories, toggleCategory);

    // Hike mode functionality
    const hikeModeBtn = document.getElementById('hike-mode-btn');
    const hikeFilterPanel = document.getElementById('hike-filter-panel')!;
    const filterContent = document.getElementById('filter-content')!;
    const filterCloseBtn = document.getElementById('filter-close-btn')!;
    const mobileFilterContainer = document.getElementById('mobile-filter-container')!;

    // Calculate min/max values for hikes
    const hikes = config.pins.filter(p => p.category === 'Hike' && p.distance && p.elevation_gain);
    const distances = hikes.map(h => h.distance!);
    const elevations = hikes.map(h => h.elevation_gain!);

    const minDistance = distances.length > 0 ? Math.min(...distances) : 0;
    const maxDistance = distances.length > 0 ? Math.max(...distances) : 100;
    const minElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
    const maxElevation = elevations.length > 0 ? Math.max(...elevations) : 10000;

    // Initialize filter ranges with actual values
    currentMinDistance = minDistance;
    currentMaxDistance = maxDistance;
    currentMinElevation = minElevation;
    currentMaxElevation = maxElevation;

    function renderFilterPanel() {
      filterContent.innerHTML = `
        <div class="filter-group">
          <div class="filter-label">
            <span>Distance</span>
            <span class="filter-value" id="distance-value">${currentMinDistance.toFixed(1)} - ${currentMaxDistance.toFixed(1)} mi</span>
          </div>
          <div class="dual-range">
            <div class="range-track"></div>
            <div class="range-fill" id="distance-fill"></div>
            <input type="range" id="distance-min" class="filter-slider" min="${minDistance}" max="${maxDistance}" step="0.1" value="${currentMinDistance}">
            <input type="range" id="distance-max" class="filter-slider" min="${minDistance}" max="${maxDistance}" step="0.1" value="${currentMaxDistance}">
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">
            <span>Elevation Gain</span>
            <span class="filter-value" id="elevation-value">${Math.round(currentMinElevation)} - ${Math.round(currentMaxElevation)} ft</span>
          </div>
          <div class="dual-range">
            <div class="range-track"></div>
            <div class="range-fill" id="elevation-fill"></div>
            <input type="range" id="elevation-min" class="filter-slider" min="${minElevation}" max="${maxElevation}" step="10" value="${currentMinElevation}">
            <input type="range" id="elevation-max" class="filter-slider" min="${minElevation}" max="${maxElevation}" step="10" value="${currentMaxElevation}">
          </div>
        </div>
      `;

      // Setup range sliders
      setupRangeSlider('distance', minDistance, maxDistance, (min, max) => {
        currentMinDistance = min;
        currentMaxDistance = max;
        filterHikes();
      });

      setupRangeSlider('elevation', minElevation, maxElevation, (min, max) => {
        currentMinElevation = min;
        currentMaxElevation = max;
        filterHikes();
      });
    }

    function setupRangeSlider(id: string, min: number, max: number, onChange: (min: number, max: number) => void) {
      const minSlider = document.getElementById(`${id}-min`) as HTMLInputElement;
      const maxSlider = document.getElementById(`${id}-max`) as HTMLInputElement;
      const valueDisplay = document.getElementById(`${id}-value`)!;
      const fill = document.getElementById(`${id}-fill`)!;

      function updateValue() {
        let minVal = parseFloat(minSlider.value);
        let maxVal = parseFloat(maxSlider.value);

        if (minVal > maxVal) {
          [minVal, maxVal] = [maxVal, minVal];
          minSlider.value = minVal.toString();
          maxSlider.value = maxVal.toString();
        }

        // Update display
        if (id === 'distance') {
          valueDisplay.textContent = `${minVal.toFixed(1)} - ${maxVal.toFixed(1)} mi`;
        } else {
          valueDisplay.textContent = `${Math.round(minVal)} - ${Math.round(maxVal)} ft`;
        }

        // Update fill bar
        const percentMin = ((minVal - min) / (max - min)) * 100;
        const percentMax = ((maxVal - min) / (max - min)) * 100;
        fill.style.left = `${percentMin}%`;
        fill.style.width = `${percentMax - percentMin}%`;

        onChange(minVal, maxVal);
      }

      minSlider.addEventListener('input', updateValue);
      maxSlider.addEventListener('input', updateValue);
      updateValue();
    }

    function filterHikes() {
      // Update visible markers (which now respects hike filters)
      updateVisibleMarkers();

      // Update side panel if open
      if (sidePanel.classList.contains('open')) {
        renderSidePanel();
      }
    }

    function toggleHikeMode() {
      hikeModeActive = !hikeModeActive;

      if (hikeModeActive) {
        // Activate hike mode
        hikeModeBtn?.classList.add('active');

        // Save current category selection before entering hike mode
        preHikeModeCategories = new Set(activeCategories);

        // Hide all non-hike categories
        config.categories.forEach(cat => {
          if (cat.name !== 'Hike') {
            activeCategories.delete(cat.name);
          } else {
            activeCategories.add(cat.name);
          }
        });

        // Show filter panel
        const isMobile = window.innerWidth <= 768;
        const sidePanelOpen = sidePanel.classList.contains('open');

        // On mobile, automatically open side panel for hike mode
        if (isMobile && !sidePanelOpen) {
          sidePanel.classList.add('open');
          mapElement.classList.add('panel-open');
          renderSidePanel();
          legendElement.classList.add('hidden');
          showLegendBtn.classList.add('visible');

          // Invalidate map size after transition
          setTimeout(() => {
            map.invalidateSize();
          }, 350);
        }

        if (isMobile) {
          // On mobile, show in mobile container
          mobileFilterContainer.classList.remove('empty');
          mobileFilterContainer.appendChild(hikeFilterPanel);
        } else {
          // On desktop, show as overlay
          document.body.appendChild(hikeFilterPanel);
        }

        hikeFilterPanel.classList.add('visible');
        legendElement.classList.add('hidden');

        // Render filter panel
        renderFilterPanel();

        // Update visible markers
        updateVisibleMarkers();

        // Update hike routes (show only hikes now)
        updateHikeRoutes();

        // Update legend visual state
        document.querySelectorAll('.legend-item').forEach(item => {
          const category = item.getAttribute('data-category');
          if (category !== 'Hike') {
            item.classList.add('inactive');
          } else {
            item.classList.remove('inactive');
          }
        });
      } else {
        // Deactivate hike mode
        hikeModeBtn?.classList.remove('active');
        hikeFilterPanel.classList.remove('visible');
        legendElement.classList.remove('hidden');
        showLegendBtn.classList.remove('visible');
        mobileFilterContainer.classList.add('empty');

        // Restore previous category selection
        if (preHikeModeCategories) {
          activeCategories.clear();
          preHikeModeCategories.forEach(cat => activeCategories.add(cat));
          preHikeModeCategories = null;
        } else {
          // Fallback: restore all categories except Mountains
          config.categories.forEach(cat => {
            if (cat.name !== 'Mountains') {
              activeCategories.add(cat.name);
            }
          });
        }

        // Reset filter values
        currentMinDistance = minDistance;
        currentMaxDistance = maxDistance;
        currentMinElevation = minElevation;
        currentMaxElevation = maxElevation;

        // Update visible markers
        updateVisibleMarkers();

        // Update hike routes
        updateHikeRoutes();

        // Update legend visual state to match restored categories
        document.querySelectorAll('.legend-item').forEach(item => {
          const category = item.getAttribute('data-category');
          if (category && activeCategories.has(category)) {
            item.classList.remove('inactive');
          } else {
            item.classList.add('inactive');
          }
        });
      }

      // Update side panel if open
      if (sidePanel.classList.contains('open')) {
        renderSidePanel();
      }
    }

    if (hikeModeBtn) {
      hikeModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHikeMode();
      });
    }

    filterCloseBtn.addEventListener('click', () => {
      if (hikeModeActive) {
        toggleHikeMode();
      }
    });

    // Legend hide/show functionality
    const legendElement = document.getElementById('legend')!;
    const legendHideBtn = document.getElementById('legend-hide-btn')!;
    const showLegendBtn = document.getElementById('show-legend-btn')!;

    legendHideBtn.addEventListener('click', () => {
      legendElement.classList.add('hidden');
      showLegendBtn.classList.add('visible');
    });

    showLegendBtn.addEventListener('click', () => {
      legendElement.classList.remove('hidden');
      showLegendBtn.classList.remove('visible');
    });

    // Panel toggle button
    panelToggle.addEventListener('click', () => {
      const isOpen = sidePanel.classList.contains('open');
      const isMobile = window.innerWidth <= 768;

      if (isOpen) {
        sidePanel.classList.remove('open');
        mapElement.classList.remove('panel-open');
        // Don't change legend state when closing - maintain current state

        // Exit hike mode when closing panel on mobile
        if (isMobile && hikeModeActive) {
          toggleHikeMode();
        }
      } else {
        sidePanel.classList.add('open');
        mapElement.classList.add('panel-open');
        renderSidePanel(); // Refresh content

        // Hide legend by default when panel opens on mobile (first time only)
        if (isMobile) {
          legendElement.classList.add('hidden');
          showLegendBtn.classList.add('visible');
        }
      }

      // Invalidate map size after transition completes
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Panel close button
    panelClose.addEventListener('click', () => {
      const isMobile = window.innerWidth <= 768;

      sidePanel.classList.remove('open');
      mapElement.classList.remove('panel-open');
      // Don't change legend state when closing - maintain current state

      // Exit hike mode when closing panel on mobile
      if (isMobile && hikeModeActive) {
        toggleHikeMode();
      }

      // Invalidate map size after transition completes
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Search functionality
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    const searchClear = document.getElementById('search-clear')!;
    const searchResults = document.getElementById('search-results')!;

    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();

      // Toggle clear button visibility
      searchClear.classList.toggle('visible', query.length > 0);

      if (!query) {
        searchResults.classList.remove('visible');
        searchResults.innerHTML = '';
        return;
      }

      // Search pins by name, description, and category
      const matches = config.pins.filter(pin =>
        pin.name.toLowerCase().includes(query) ||
        pin.description.toLowerCase().includes(query) ||
        pin.category.toLowerCase().includes(query)
      );

      if (matches.length === 0) {
        searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
        searchResults.classList.add('visible');
        return;
      }

      // Render results
      searchResults.innerHTML = '';
      matches.slice(0, 10).forEach(pin => { // Limit to 10 results
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
          <div class="search-result-name">${pin.name}</div>
          <div class="search-result-category">${pin.category}</div>
        `;
        item.addEventListener('click', () => {
          // Fly to the pin
          map.flyTo([pin.coordinates[0], pin.coordinates[1]], 15, {
            duration: 0.8
          });

          // Find and open the marker popup
          const marker = pinMarkers.get(pin.name);
          if (marker) {
            setTimeout(() => {
              marker.openPopup();
            }, 800);
          }

          // Clear search
          searchInput.value = '';
          searchClear.classList.remove('visible');
          searchResults.classList.remove('visible');
          searchResults.innerHTML = '';
        });
        searchResults.appendChild(item);
      });

      searchResults.classList.add('visible');
    });

    // Clear search
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      searchResults.classList.remove('visible');
      searchResults.innerHTML = '';
    });

    // Close results when clicking outside
    document.addEventListener('click', (e) => {
      const container = document.getElementById('search-container')!;
      if (!container.contains(e.target as Node)) {
        searchResults.classList.remove('visible');
      }
    });

    // Routing functionality
    const routePanel = document.getElementById('route-panel')!;
    const routePanelClose = document.getElementById('route-panel-close')!;
    const drivingTimeToggle = document.getElementById('driving-time-toggle')!;
    const routeStartInput = document.getElementById('route-start-input') as HTMLInputElement;
    const routeEndInput = document.getElementById('route-end-input') as HTMLInputElement;
    const routeStartSuggestions = document.getElementById('route-start-suggestions')!;
    const routeEndSuggestions = document.getElementById('route-end-suggestions')!;
    const routeClearStart = document.getElementById('route-clear-start')!;
    const routeClearEnd = document.getElementById('route-clear-end')!;
    const routeResult = document.getElementById('route-result')!;
    const routePickStart = document.getElementById('route-pick-start')!;
    const routePickEnd = document.getElementById('route-pick-end')!;

    let selectedStartPin: string = '';
    let selectedEndPin: string = '';
    let focusedInput: 'start' | 'end' | null = null;
    let pickMode: 'start' | 'end' | null = null;
    let pickModeBanner: HTMLElement | null = null;

    // Track which input is focused
    routeStartInput.addEventListener('focus', () => {
      focusedInput = 'start';
    });

    routeEndInput.addEventListener('focus', () => {
      focusedInput = 'end';
    });

    routeStartInput.addEventListener('blur', () => {
      // Delay clearing focus to allow click events to process
      setTimeout(() => {
        if (focusedInput === 'start') focusedInput = null;
      }, 200);
    });

    routeEndInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (focusedInput === 'end') focusedInput = null;
      }, 200);
    });

    // Set default to "Jesse's House" if it exists
    const jessesHouse = config.pins.find(p => p.name === "Jesse's House");
    if (jessesHouse) {
      routeStartInput.value = "Jesse's House";
      selectedStartPin = "Jesse's House";
      routeClearStart.classList.add('visible');
    }

    // Autocomplete functionality
    function setupAutocomplete(input: HTMLInputElement, suggestionsEl: HTMLElement, onSelect: (pinName: string) => void) {
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase().trim();

        if (!query) {
          suggestionsEl.classList.remove('visible');
          suggestionsEl.innerHTML = '';
          return;
        }

        // Substring matching
        const matches = config.pins.filter(pin =>
          pin.name.toLowerCase().includes(query)
        );

        if (matches.length === 0) {
          suggestionsEl.classList.remove('visible');
          suggestionsEl.innerHTML = '';
          return;
        }

        // Render suggestions
        suggestionsEl.innerHTML = '';
        matches.forEach(pin => {
          const item = document.createElement('div');
          item.className = 'route-suggestion-item';
          item.textContent = pin.name;
          item.addEventListener('click', () => {
            input.value = pin.name;
            onSelect(pin.name);
            suggestionsEl.classList.remove('visible');
            suggestionsEl.innerHTML = '';
          });
          suggestionsEl.appendChild(item);
        });

        suggestionsEl.classList.add('visible');
      });

      // Close suggestions when clicking outside
      document.addEventListener('click', (e) => {
        if (!input.contains(e.target as Node) && !suggestionsEl.contains(e.target as Node)) {
          suggestionsEl.classList.remove('visible');
        }
      });
    }

    setupAutocomplete(routeStartInput, routeStartSuggestions, (pinName) => {
      selectedStartPin = pinName;
      routeClearStart.classList.add('visible');
      calculateRoute();
    });

    setupAutocomplete(routeEndInput, routeEndSuggestions, (pinName) => {
      selectedEndPin = pinName;
      routeClearEnd.classList.add('visible');
      calculateRoute();
    });

    // Pick from map functionality
    function enterPickMode(mode: 'start' | 'end') {
      pickMode = mode;
      const isMobile = window.innerWidth <= 768;

      // Update button states
      routePickStart.classList.toggle('active', mode === 'start');
      routePickEnd.classList.toggle('active', mode === 'end');

      // Create and show banner
      if (!pickModeBanner) {
        pickModeBanner = document.createElement('div');
        pickModeBanner.className = 'route-pick-mode-banner';
        document.body.appendChild(pickModeBanner);
      }

      const label = mode === 'start' ? 'Start' : 'Destination';
      pickModeBanner.innerHTML = `Tap a pin to set as ${label} <button id="cancel-pick-mode">Cancel</button>`;
      pickModeBanner.style.display = 'block';

      document.getElementById('cancel-pick-mode')!.addEventListener('click', exitPickMode);

      // On mobile, minimize the route panel to show more map
      if (isMobile) {
        routePanel.classList.remove('open');
        mapElement.classList.remove('route-panel-open');
        setTimeout(() => map.invalidateSize(), 350);
      }
    }

    function exitPickMode() {
      pickMode = null;
      routePickStart.classList.remove('active');
      routePickEnd.classList.remove('active');

      if (pickModeBanner) {
        pickModeBanner.style.display = 'none';
      }

      // On mobile, reopen the route panel
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        routePanel.classList.add('open');
        mapElement.classList.add('route-panel-open');
        setTimeout(() => map.invalidateSize(), 350);
      }
    }

    function handlePickModeSelection(pinName: string) {
      if (!pickMode) return;

      if (pickMode === 'start') {
        routeStartInput.value = pinName;
        selectedStartPin = pinName;
        routeClearStart.classList.add('visible');
      } else {
        routeEndInput.value = pinName;
        selectedEndPin = pinName;
        routeClearEnd.classList.add('visible');
      }

      exitPickMode();
      calculateRoute();
    }

    // Pick button click handlers
    routePickStart.addEventListener('click', () => {
      if (pickMode === 'start') {
        exitPickMode();
      } else {
        enterPickMode('start');
      }
    });

    routePickEnd.addEventListener('click', () => {
      if (pickMode === 'end') {
        exitPickMode();
      } else {
        enterPickMode('end');
      }
    });

    function clearRoute() {
      if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
      }
      routeResult.classList.remove('visible');
    }

    function calculateRoute() {
      const startName = selectedStartPin;
      const endName = selectedEndPin;

      if (!startName || !endName) {
        clearRoute();
        return;
      }

      const startPin = config.pins.find(p => p.name === startName);
      const endPin = config.pins.find(p => p.name === endName);

      if (!startPin || !endPin) {
        clearRoute();
        return;
      }

      // Clear existing route
      if (routingControl) {
        map.removeControl(routingControl);
      }

      // Create routing control
      routingControl = L.Routing.control({
        waypoints: [
          L.latLng(startPin.coordinates[0], startPin.coordinates[1]),
          L.latLng(endPin.coordinates[0], endPin.coordinates[1])
        ],
        router: L.Routing.osrmv1({
          serviceUrl: 'https://router.project-osrm.org/route/v1'
        }),
        show: false, // Hide the default instructions panel
        addWaypoints: false,
        routeWhileDragging: false,
        fitSelectedRoutes: true,
        lineOptions: {
          styles: [{ color: '#3498db', weight: 4, opacity: 0.7 }],
          extendToWaypoints: true,
          missingRouteTolerance: 0
        }
      }).addTo(map);

      // Listen for route found event
      routingControl.on('routesfound', (e: any) => {
        const routes = e.routes;
        if (routes && routes.length > 0) {
          const route = routes[0];
          const distanceMiles = (route.summary.totalDistance / 1609.34).toFixed(1);
          const timeMinutes = Math.round(route.summary.totalTime / 60);
          const hours = Math.floor(timeMinutes / 60);
          const mins = timeMinutes % 60;

          let timeStr = '';
          if (hours > 0) {
            timeStr = `${hours}h ${mins}min`;
          } else {
            timeStr = `${mins}min`;
          }

          routeResult.innerHTML = `<div class="route-result-text"><strong>${startPin.name}</strong> → <strong>${endPin.name}</strong><br>${distanceMiles} mi • ${timeStr} drive</div>`;
          routeResult.classList.add('visible');
        }
      });
    }

    // Toggle driving time panel
    drivingTimeToggle.addEventListener('click', () => {
      const isOpen = routePanel.classList.contains('open');

      if (isOpen) {
        routePanel.classList.remove('open');
        drivingTimeToggle.classList.remove('active');
        mapElement.classList.remove('route-panel-open');
        clearRoute();
      } else {
        routePanel.classList.add('open');
        drivingTimeToggle.classList.add('active');
        mapElement.classList.add('route-panel-open');

        // Hide legend when driving time panel opens
        legendElement.classList.add('hidden');
        showLegendBtn.classList.add('visible');

        // Calculate route if both selections exist
        if (selectedStartPin && selectedEndPin) {
          calculateRoute();
        }
      }

      // Invalidate map size after transition
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    routePanelClose.addEventListener('click', () => {
      routePanel.classList.remove('open');
      drivingTimeToggle.classList.remove('active');
      mapElement.classList.remove('route-panel-open');
      clearRoute();

      // Invalidate map size after transition
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Clear button handlers
    routeClearStart.addEventListener('click', () => {
      routeStartInput.value = '';
      selectedStartPin = '';
      routeClearStart.classList.remove('visible');
      clearRoute();
    });

    routeClearEnd.addEventListener('click', () => {
      routeEndInput.value = '';
      selectedEndPin = '';
      routeClearEnd.classList.remove('visible');
      clearRoute();
    });

    // Highlight card when marker is clicked
    map.on('popupopen', (e: L.PopupEvent) => {
      const markerLatLng = e.popup.getLatLng();
      if (!markerLatLng) return;

      // Find which pin this is
      const pin = config.pins.find(p =>
        p.coordinates[0] === markerLatLng.lat && p.coordinates[1] === markerLatLng.lng
      );

      if (pin) {
        // If in pick mode, handle the selection
        if (pickMode) {
          handlePickModeSelection(pin.name);
          map.closePopup(); // Close the popup after selection
          return;
        }

        // If route panel is open and an input is focused, fill it with the clicked pin
        const isRoutePanelOpen = routePanel.classList.contains('open');
        if (isRoutePanelOpen && focusedInput) {
          if (focusedInput === 'start') {
            routeStartInput.value = pin.name;
            selectedStartPin = pin.name;
            routeClearStart.classList.add('visible');
            routeStartSuggestions.classList.remove('visible');
            calculateRoute();
          } else if (focusedInput === 'end') {
            routeEndInput.value = pin.name;
            selectedEndPin = pin.name;
            routeClearEnd.classList.add('visible');
            routeEndSuggestions.classList.remove('visible');
            calculateRoute();
          }
          return; // Don't proceed with card highlighting
        }
        // Highlight corresponding card
        document.querySelectorAll('.location-card').forEach(c => c.classList.remove('active'));
        const card = document.querySelector(`.location-card[data-pin-name="${pin.name}"]`);
        if (card) {
          card.classList.add('active');
          // Scroll card into view if panel is open
          if (sidePanel.classList.contains('open')) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }

      }
    });

  } catch (error) {
    console.error('Failed to initialize map:', error);
    alert('Failed to load map configuration. Please check the console for details.');
  }
}

// Auth UI elements
const authScreen = document.getElementById('auth-screen')!;
const appContainer = document.getElementById('app-container')!;
const authForm = document.getElementById('auth-form') as HTMLFormElement;
const authEmail = document.getElementById('auth-email') as HTMLInputElement;
const authPassword = document.getElementById('auth-password') as HTMLInputElement;
const authSubmit = document.getElementById('auth-submit') as HTMLButtonElement;
const authError = document.getElementById('auth-error')!;
const authModeText = document.getElementById('auth-mode-text')!;
const authModeToggle = document.getElementById('auth-mode-toggle')!;
const logoutBtn = document.getElementById('logout-btn')!;

let isSignUp = false;
let mapInitialized = false;

function showApp() {
  authScreen.classList.add('hidden');
  appContainer.classList.remove('hidden');
  if (!mapInitialized) {
    initMap();
    mapInitialized = true;
  }
}

function showAuth() {
  authScreen.classList.remove('hidden');
  appContainer.classList.add('hidden');
  // Reset form state
  authSubmit.disabled = false;
  authError.textContent = '';
  authPassword.value = '';
}

// Toggle between sign in and sign up
authModeToggle.addEventListener('click', () => {
  isSignUp = !isSignUp;
  if (isSignUp) {
    authModeText.textContent = 'Already have an account?';
    authModeToggle.textContent = 'Sign In';
    authSubmit.textContent = 'Sign Up';
  } else {
    authModeText.textContent = "Don't have an account?";
    authModeToggle.textContent = 'Sign Up';
    authSubmit.textContent = 'Sign In';
  }
  authError.textContent = '';
});

// Handle form submission
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!supabase) {
    authError.textContent = 'Auth not configured. Contact admin.';
    return;
  }

  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) {
    authError.textContent = 'Please enter email and password.';
    return;
  }

  authSubmit.disabled = true;
  authError.textContent = '';

  try {
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw error;
      authError.style.color = '#27ae60';
      authError.textContent = 'Check your email to confirm your account!';
      authSubmit.disabled = false;
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showApp();
    }
  } catch (err: any) {
    authError.style.color = '#e74c3c';
    authError.textContent = err.message || 'Authentication failed.';
    authSubmit.disabled = false;
  }
});

// Handle logout
logoutBtn.addEventListener('click', async () => {
  if (supabase) {
    // Sign out from all devices/tabs to fully clear the session
    await supabase.auth.signOut({ scope: 'global' });
  }
  showAuth();
});

// Initialize: check auth state
async function init() {
  // If Supabase is not configured, skip auth and show the app directly
  if (!supabase) {
    console.warn('Supabase not configured. Showing app without auth.');
    showApp();
    return;
  }

  // Listen for auth state changes first (before checking session)
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      // Clear the hash from URL after successful auth (cleaner URL)
      if (window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname);
      }
      showApp();
    } else {
      showAuth();
    }
  });

  // Handle email confirmation redirect (tokens in URL hash)
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');

  if (accessToken && refreshToken) {
    // Exchange the tokens from the URL for a session
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (!error) {
      // onAuthStateChange will handle showing the app
      return;
    }
  }

  // Check if user is already logged in
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    showApp();
  } else {
    showAuth();
  }
}

// Start the app
init();
