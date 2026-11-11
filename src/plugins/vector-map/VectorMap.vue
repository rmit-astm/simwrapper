<template lang="pug">
.vector-map(oncontextmenu="return false")
  .map-container(:id="mapId")
  .status-box(v-if="statusText") {{ statusText }}

  .map-legend(v-if="showLegend && isLoaded")
    p.legend-title {{ legendTitle }}
    .legend-row(v-for="item in legendItems" :key="item.label")
      span.swatch(:style="{ background: item.color }")
      span {{ item.label }}

  .map-controls(v-if="showControls && isLoaded")
    .segmented(v-if="!isGeneric")
      button(:class="{ active: styleMode === 'cycleway' }" @click="setStyle('cycleway')") Cycleway
      button(:class="{ active: styleMode === 'lts' }" @click="setStyle('lts')") LTS
    label.opacity
      span Base opacity
      input(type="range" min="0" max="100" v-model.number="opacity" @input="updateOpacity")

  .map-tooltip(v-if="tooltipHtml" :style="tooltipStyle" v-html="tooltipHtml")
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import * as maplibregl from 'maplibre-gl'
import * as chromatic from 'd3-scale-chromatic'

import globalStore from '@/store'
import { FileSystemConfig } from '@/Globals'
import HTTPFileSystem from '@/js/HTTPFileSystem'
import DashboardDataManager from '@/js/DashboardDataManager'
import { ensurePmtilesProtocol, registerPmtilesUrl } from '@/js/pmtiles-protocol'

const BASE_URL = import.meta.env.BASE_URL

const DEFAULT_CYCLEWAY_COLORS: Record<string, string> = {
  bikepath: '#008300',
  shared_path: '#1baf7a',
  separated_lane: '#2a78d6',
  simple_lane: '#eda100',
  inadequate_lane: '#eb6834',
  shared_street: '#e34948',
}

const DEFAULT_LTS_COLORS: Record<string, string> = {
  '-3': '#004000',
  '-2': '#008000',
  '-1': '#7fbf7f',
  '0': '#b8b8b8',
}

const CYCLEWAY_LABELS: Record<string, string> = {
  bikepath: 'Off-road bike path',
  shared_path: 'Shared path',
  separated_lane: 'Protected bike lane',
  simple_lane: 'Painted bike lane',
  inadequate_lane: 'Substandard painted lane',
  shared_street: 'Shared street',
}

const PALETTE_INTERPOLATORS: Record<string, (t: number) => string> = {
  Purples: chromatic.interpolatePurples,
  Oranges: chromatic.interpolateOranges,
  Blues: chromatic.interpolateBlues,
  Greens: chromatic.interpolateGreens,
  Reds: chromatic.interpolateReds,
  Greys: chromatic.interpolateGreys,
  Viridis: chromatic.interpolateViridis,
}

export default defineComponent({
  name: 'VectorMap',
  props: {
    fileSystemConfig: { type: Object as PropType<FileSystemConfig>, required: true },
    subfolder: { type: String, required: true },
    config: { type: Object as any, required: true },
    datamanager: { type: Object as PropType<DashboardDataManager>, required: false },
  },
  data() {
    return {
      mapId: `vector-map-${Math.floor(1e12 * Math.random())}`,
      map: null as maplibregl.Map | null,
      resizeObserver: null as ResizeObserver | null,
      statusText: 'Loading vector tiles...',
      isLoaded: false,
      styleMode: 'cycleway',
      opacity: 80,
      hiddenIds: [] as number[],
      tileStyle: null as any,
      tooltipHtml: '',
      tooltipStyle: { left: '0px', top: '0px' },
      didEmitLoaded: false,
    }
  },
  computed: {
    fileApi(): HTTPFileSystem {
      return new HTTPFileSystem(this.fileSystemConfig, globalStore)
    },
    isGeneric(): boolean {
      return !!this.config.tiles
    },
    showLegend(): boolean {
      return this.config.legend !== false
    },
    showControls(): boolean {
      return this.config.controls !== false
    },
    cyclewayColors(): Record<string, string> {
      return this.config.style?.cyclewayColors || DEFAULT_CYCLEWAY_COLORS
    },
    ltsColors(): Record<string, string> {
      return this.config.style?.ltsChangeColors || DEFAULT_LTS_COLORS
    },
    legendTitle(): string {
      if (this.isGeneric) {
        return this.config.legend?.title || this.config.layer?.field || 'Data'
      }
      return this.styleMode === 'lts' ? 'LTS change' : 'Cycleway'
    },
    legendItems(): Array<{ label: string; color: string }> {
      if (this.isGeneric) return this.genericLegendItems()
      if (this.styleMode === 'lts') {
        return Object.keys(DEFAULT_LTS_COLORS).map((key) => ({
          label: key === '0' ? 'No change' : `LTS change ${key}`,
          color: this.ltsColors[key] || DEFAULT_LTS_COLORS[key],
        }))
      }
      return Object.keys(DEFAULT_CYCLEWAY_COLORS).map((key) => ({
        label: CYCLEWAY_LABELS[key] || key,
        color: this.cyclewayColors[key] || DEFAULT_CYCLEWAY_COLORS[key],
      }))
    },
  },
  async mounted() {
    this.styleMode = this.config.style?.mode || this.config.style || 'cycleway'
    this.opacity = Math.round(
      Number(this.config.base?.opacity ?? this.config.opacity ?? 0.8) * 100
    )

    try {
      ensurePmtilesProtocol()
      if (this.isGeneric) {
        await this.loadTileStyle()
      } else {
        this.hiddenIds = await this.loadHiddenIds()
      }
      this.createMap()
    } catch (error) {
      this.fail(error)
    }
  },
  beforeDestroy() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.map) {
      this.map.remove()
      this.map = null
    }
  },
  watch: {
    '$store.state.resizeEvents'() {
      this.map?.resize()
    },
  },
  methods: {
    fail(error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.statusText = `Vector map error: ${message}`
      this.$emit('error', this.statusText)
    },

    tileUrl(url: string): string {
      if (url.startsWith('pmtiles://')) return url
      const absolute = url.startsWith('/') ? location.origin + url : url
      return 'pmtiles://' + absolute
    },

    resolveFile(name: string): string {
      if (!name) return ''
      if (/^(https?:|pmtiles:|\/)/i.test(name)) return name
      const path = `${this.subfolder ? this.subfolder + '/' : ''}${name}`.replace(
        /\/+/g,
        '/'
      )
      return this.fileApi.cleanURL(path)
    },

    async loadHiddenIds(): Promise<number[]> {
      const hiddenFile = this.config.edits?.hiddenFile
      if (!hiddenFile) return []
      try {
        const response = await fetch(this.resolveFile(hiddenFile))
        if (!response.ok) return []
        const json = await response.json()
        return (json.hidden_link_ids || []).map((id: any) => Number(id))
      } catch {
        return []
      }
    },

    async loadTileStyle(): Promise<void> {
      const styleFile = this.config.layer?.styleFile
      if (!styleFile) return
      try {
        const response = await fetch(this.resolveFile(styleFile))
        if (response.ok) this.tileStyle = await response.json()
      } catch {
        // The layer will use its inline/default style until the file exists.
      }
    },

    styleForField(): any {
      const field = this.config.layer?.field
      const style = this.tileStyle
      if (!style) return {}
      if (field && style[field]) return style[field]
      return style
    },

    paletteColors(name: string, count: number): string[] {
      const fn = PALETTE_INTERPOLATORS[name] || chromatic.interpolatePurples
      if (count <= 1) return [fn(0.5)]
      return Array.from({ length: count }, (_, i) => fn(i / (count - 1)))
    },

    linearBreaks(min: number, max: number, count: number): number[] {
      if (count <= 1) return []
      const lo = Number.isFinite(min) ? min : 0
      const hi = Number.isFinite(max) && max !== lo ? max : lo + 1
      return Array.from({ length: count - 1 }, (_, i) => lo + ((i + 1) * (hi - lo)) / count)
    },

    numericBreaks(): { breaks: number[]; colors: string[]; field: string } {
      const layer = this.config.layer || {}
      const style = this.styleForField()
      const field = style.field || layer.field || ''
      let colors: string[] = style.colors || layer.colors || []
      let breaks: number[] = style.breaks || layer.breaks || []
      if (!colors.length) {
        colors = this.paletteColors(layer.palette || 'Purples', Math.max(2, breaks.length + 1 || 6))
      }
      if (!breaks.length) {
        breaks = this.linearBreaks(
          Number(style.min ?? layer.min ?? 0),
          Number(style.max ?? layer.max ?? 1),
          Math.max(2, colors.length)
        )
      }
      // MapLibre step expressions require strictly ascending inputs. Quantile
      // breaks can repeat when many SA1 areas share the same value.
      breaks = breaks
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)
        .filter((value, index, list) => index === 0 || value > list[index - 1])
      if (colors.length < breaks.length + 1) {
        colors = this.paletteColors(layer.palette || 'Purples', breaks.length + 1)
      }
      return { breaks, colors, field }
    },

    stepExpression(field: string, breaks: number[], colors: string[]): any {
      if (!field) return colors[0] || '#bdbdbd'
      const expr: any[] = ['step', ['to-number', ['get', field]], colors[0]]
      breaks.forEach((value, index) => {
        expr.push(value, colors[index + 1] || colors[colors.length - 1])
      })
      return expr
    },

    formatNumber(value: number): string {
      if (!Number.isFinite(value)) return ''
      return Math.abs(value) >= 100
        ? Math.round(value).toLocaleString('en-AU')
        : Number(value.toFixed(2)).toLocaleString('en-AU')
    },

    genericLegendItems(): Array<{ label: string; color: string }> {
      if (Array.isArray(this.config.legend?.items)) return this.config.legend.items
      const { breaks, colors } = this.numericBreaks()
      if (!breaks.length || !colors.length) {
        return colors.length
          ? [{ label: this.config.legend?.title || '', color: colors[colors.length - 1] }]
          : []
      }
      const items: Array<{ label: string; color: string }> = []
      items.push({ label: `< ${this.formatNumber(breaks[0])}`, color: colors[0] })
      for (let i = 0; i < breaks.length - 1; i++) {
        items.push({
          label: `${this.formatNumber(breaks[i])} – ${this.formatNumber(breaks[i + 1])}`,
          color: colors[i + 1] || colors[colors.length - 1],
        })
      }
      items.push({
        label: `≥ ${this.formatNumber(breaks[breaks.length - 1])}`,
        color: colors[breaks.length] || colors[colors.length - 1],
      })
      return items
    },

    createMap() {
      const viewState = globalStore.state.viewState as any
      const center = Array.isArray(this.config.center)
        ? this.config.center
        : viewState.center
          ? [viewState.center.lng, viewState.center.lat]
          : [viewState.longitude, viewState.latitude]
      const zoom = this.config.zoom ?? viewState.zoom ?? 6.5

      this.map = new maplibregl.Map({
        container: this.mapId,
        style: `${BASE_URL}map-styles/${globalStore.state.isDarkMode ? 'dark' : 'positron'}.json`,
        center,
        zoom,
        maxZoom: 18,
        pixelRatio: 1,
        antialias: false,
        maxTileCacheSize: 64,
        fadeDuration: 0,
        attributionControl: false,
      })

      this.map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        'top-right'
      )

      this.map.on('load', () => {
        this.addLayers().catch((error) => this.fail(error))
      })

      this.map.on('error', (event) => {
        const message = event.error?.message || String(event.error || 'unknown map error')
        // A single missing basemap tile should not blank the whole panel.
        console.warn('vector-map:', message)
      })

      if (!this.config.mapIsIndependent) {
        this.map.on('move', () => {
          if (!this.map) return
          const center = this.map.getCenter()
          globalStore.commit('setMapCamera', {
            center: [center.lng, center.lat],
            zoom: this.map.getZoom(),
            bearing: this.map.getBearing(),
            pitch: this.map.getPitch(),
            jump: true,
          })
        })
      }

      this.map.on('mousemove', (event) => this.showTooltip(event))
      this.map.on('mouseout', () => {
        this.tooltipHtml = ''
      })

      const container = document.getElementById(this.mapId)
      if (container) {
        this.resizeObserver = new ResizeObserver(() => this.map?.resize())
        this.resizeObserver.observe(container)
      }
    },

    async addLayers() {
      const map = this.map
      if (!map) return
      if (this.isGeneric) {
        await this.addGenericLayers()
        return
      }
      await this.addBoundaries(map)
      const base = this.config.base
      if (!base?.file) throw new Error('vector-map: config.base.file is required')

      const baseUrl = this.resolveFile(base.file)
      const sourceLayer = base.sourceLayer || 'links'
      await registerPmtilesUrl(baseUrl)
      map.addSource('vector-base', {
        type: 'vector',
        url: this.tileUrl(baseUrl),
      })

      let editsSourceLayer = 'links'
      if (this.config.edits?.file) {
        editsSourceLayer = this.config.edits.sourceLayer || 'links'
        const editsUrl = this.resolveFile(this.config.edits.file)
        await registerPmtilesUrl(editsUrl)
        map.addSource('vector-edits', {
          type: 'vector',
          url: this.tileUrl(editsUrl),
        })
      }

      const hiddenFilter =
        this.hiddenIds.length > 0
          ? ['!', ['in', ['get', 'link_id'], ['literal', this.hiddenIds]]]
          : undefined

      const baseWidth = [
        'interpolate',
        ['linear'],
        ['zoom'],
        6, 0.6,
        9, 0.9,
        12, 1.5,
        14, 2.2,
        16, 3.0,
      ]
      const editWidth = [
        'interpolate',
        ['linear'],
        ['zoom'],
        6, 1.5,
        10, 2.2,
        14, 3.2,
        16, 4.0,
      ]

      const baseLayer: any = {
        id: 'vector-base-links',
        type: 'line',
        source: 'vector-base',
        'source-layer': sourceLayer,
        paint: {
          'line-color': this.config.style?.baseColor || '#bdbdbd',
          'line-opacity': this.opacity / 100,
          'line-width': baseWidth,
        },
      }
      // MapLibre rejects an explicit `filter: undefined`; only add the key when
      // the scenario actually has hidden links.
      if (hiddenFilter) baseLayer.filter = hiddenFilter
      map.addLayer(baseLayer)

      if (map.getSource('vector-edits')) {
        map.addLayer({
          id: 'vector-edit-cycleway',
          type: 'line',
          source: 'vector-edits',
          'source-layer': editsSourceLayer,
          filter: ['!=', ['get', 'change_type'], 'removed'],
          paint: {
            'line-color': [
              'match',
              ['get', 'cycleway'],
              'bikepath', this.cyclewayColors.bikepath,
              'shared_path', this.cyclewayColors.shared_path,
              'separated_lane', this.cyclewayColors.separated_lane,
              'simple_lane', this.cyclewayColors.simple_lane,
              'inadequate_lane', this.cyclewayColors.inadequate_lane,
              'shared_street', this.cyclewayColors.shared_street,
              '#b8b8b8',
            ],
            'line-opacity': 1,
            'line-width': editWidth,
          },
        } as any)

        map.addLayer({
          id: 'vector-edit-lts',
          type: 'line',
          source: 'vector-edits',
          'source-layer': editsSourceLayer,
          filter: ['!=', ['get', 'change_type'], 'removed'],
          layout: { visibility: 'none' },
          paint: {
            'line-color': [
              'match',
              ['to-number', ['get', 'lts_change']],
              -3, this.ltsColors['-3'],
              -2, this.ltsColors['-2'],
              -1, this.ltsColors['-1'],
              0, this.ltsColors['0'],
              '#b8b8b8',
            ],
            'line-opacity': 1,
            'line-width': editWidth,
          },
        } as any)

        map.addLayer({
          id: 'vector-removed-links',
          type: 'line',
          source: 'vector-edits',
          'source-layer': editsSourceLayer,
          filter: ['==', ['get', 'change_type'], 'removed'],
          paint: {
            'line-color': '#d62f31',
            'line-dasharray': [2, 1],
            'line-opacity': 1,
            'line-width': 3,
          },
        } as any)
      }

      this.addBoundaryOutlines(map)
      this.setStyle(this.styleMode)

      if (this.config.bounds) {
        map.fitBounds(this.config.bounds, { padding: 30, duration: 0, maxZoom: 15 })
      }

      this.statusText = ''
      this.isLoaded = true
      this.$nextTick(() => map.resize())
      if (!this.didEmitLoaded) {
        this.didEmitLoaded = true
        this.$emit('isLoaded')
      }
    },

    async addBoundaries(map: maplibregl.Map): Promise<void> {
      const boundaries = this.config.boundaries || []
      for (let i = 0; i < boundaries.length; i++) {
        const boundary = boundaries[i]
        if (!boundary?.file) continue
        try {
          const data = await this.loadBoundaryData(boundary.file)
          if (!data) continue
          const sourceId = `vector-boundary-${i}`
          map.addSource(sourceId, { type: 'geojson', data })
          map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            paint: {
              'fill-color': boundary.fill || '#ffffff',
              'fill-opacity': boundary.opacity ?? 0.15,
            },
          } as any)
        } catch {
          // A missing or invalid boundary must not blank the data layer.
        }
      }
    },

    async loadBoundaryData(file: string): Promise<any | null> {
      const url = this.resolveFile(file)
      try {
        if (!file.toLowerCase().endsWith('.shp')) {
          const response = await fetch(url)
          return response.ok ? await response.json() : null
        }
        const base = url.replace(/\.shp$/i, '')
        const [shp, dbf, prj] = await Promise.all([
          fetch(`${base}.shp`).then((r) => (r.ok ? r.arrayBuffer() : null)),
          fetch(`${base}.dbf`).then((r) => (r.ok ? r.arrayBuffer() : null)),
          fetch(`${base}.prj`).then((r) => (r.ok ? r.text() : null)),
        ])
        if (!shp) return null
        const { loadShapefileFromBuffers } = await import('@/js/geo-utils')
        const features = await loadShapefileFromBuffers({
          shp,
          dbf: dbf ?? undefined,
          prj: prj ?? undefined,
        })
        return { type: 'FeatureCollection', features }
      } catch {
        return null
      }
    },

    addBoundaryOutlines(map: maplibregl.Map): void {
      // Draw fills under the data so it stays readable, but draw the outline
      // on top of the network; otherwise dense green links hide the border.
      const boundaries = this.config.boundaries || []
      for (let i = 0; i < boundaries.length; i++) {
        const boundary = boundaries[i]
        if (!boundary?.file) continue
        const sourceId = `vector-boundary-${i}`
        if (!map.getSource(sourceId)) continue
        if (map.getLayer(`${sourceId}-line`)) continue
        map.addLayer({
          id: `${sourceId}-line`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': boundary.stroke || '#d62f31',
            'line-width': boundary.width ?? 2,
          },
        } as any)
      }
    },

    async addGenericLayers(): Promise<void> {
      const map = this.map
      if (!map) return
      const tiles = this.config.tiles
      if (!tiles?.file) throw new Error('vector-map: config.tiles.file is required')
      const layer = this.config.layer || {}
      const sourceLayer = tiles.sourceLayer || 'data'

      await this.addBoundaries(map)

      const tilesUrl = this.resolveFile(tiles.file)
      await registerPmtilesUrl(tilesUrl)
      map.addSource('vector-data', {
        type: 'vector',
        url: this.tileUrl(tilesUrl),
      })

      const { breaks, colors, field } = this.numericBreaks()
      const colorExpression = this.stepExpression(field, breaks, colors)
      const opacity = Number(layer.opacity ?? this.opacity / 100)
      const lineWidth = [
        'interpolate',
        ['linear'],
        ['zoom'],
        6, 0.6,
        10, 1.2,
        14, 2.2,
        16, 3.0,
      ]

      if ((layer.type || 'fill') === 'fill') {
        map.addLayer({
          id: 'vector-data-layer',
          type: 'fill',
          source: 'vector-data',
          'source-layer': sourceLayer,
          paint: {
            'fill-color': colorExpression,
            'fill-opacity': opacity,
          },
        } as any)
        map.addLayer({
          id: 'vector-data-outline',
          type: 'line',
          source: 'vector-data',
          'source-layer': sourceLayer,
          paint: {
            'line-color': layer.outlineColor || '#ffffff',
            'line-width': layer.outlineWidth ?? 0.6,
            'line-opacity': 0.75,
          },
        } as any)
      } else {
        map.addLayer({
          id: 'vector-data-layer',
          type: 'line',
          source: 'vector-data',
          'source-layer': sourceLayer,
          paint: {
            'line-color': colorExpression,
            'line-opacity': opacity,
            'line-width': layer.width ?? lineWidth,
          },
        } as any)
      }

      this.addBoundaryOutlines(map)

      if (this.config.bounds) {
        map.fitBounds(this.config.bounds, { padding: 30, duration: 0, maxZoom: 15 })
      }

      this.statusText = ''
      this.isLoaded = true
      this.$nextTick(() => map.resize())
      if (!this.didEmitLoaded) {
        this.didEmitLoaded = true
        this.$emit('isLoaded')
      }
    },

    setStyle(mode: string) {
      if (this.isGeneric) return
      this.styleMode = mode === 'lts' ? 'lts' : 'cycleway'
      const map = this.map
      if (!map) return
      if (map.getLayer('vector-edit-cycleway')) {
        map.setLayoutProperty(
          'vector-edit-cycleway',
          'visibility',
          this.styleMode === 'cycleway' ? 'visible' : 'none'
        )
      }
      if (map.getLayer('vector-edit-lts')) {
        map.setLayoutProperty(
          'vector-edit-lts',
          'visibility',
          this.styleMode === 'lts' ? 'visible' : 'none'
        )
      }
    },

    updateOpacity(event?: Event) {
      if (event?.target) this.opacity = Number((event.target as HTMLInputElement).value)
      if (this.isGeneric) {
        if (this.map?.getLayer('vector-data-layer')) {
          const property =
            (this.config.layer?.type || 'fill') === 'fill'
              ? 'fill-opacity'
              : 'line-opacity'
          this.map.setPaintProperty('vector-data-layer', property, this.opacity / 100)
        }
        return
      }
      if (this.map?.getLayer('vector-base-links')) {
        this.map.setPaintProperty('vector-base-links', 'line-opacity', this.opacity / 100)
      }
    },

    visibleTooltipLayers(): string[] {
      const map = this.map
      if (!map) return []
      if (this.isGeneric) {
        return map.getLayer('vector-data-layer') ? ['vector-data-layer'] : []
      }
      const layers: string[] = []
      for (const id of [
        'vector-base-links',
        'vector-edit-cycleway',
        'vector-edit-lts',
        'vector-removed-links',
      ]) {
        if (!map.getLayer(id)) continue
        if (map.getLayoutProperty(id, 'visibility') === 'none') continue
        layers.push(id)
      }
      return layers
    },

    showTooltip(event: any) {
      const map = this.map
      if (!map) return
      const layers = this.visibleTooltipLayers()
      if (!layers.length) {
        this.tooltipHtml = ''
        return
      }
      const features = map.queryRenderedFeatures(event.point, { layers })
      if (!features.length) {
        this.tooltipHtml = ''
        return
      }
      const props = features[0].properties || {}
      const fields =
        this.config.tooltipFields ||
        (this.isGeneric
          ? [this.config.layer?.field, 'SA1_CODE21', 'link_id'].filter(Boolean)
          : ['change_type', 'link_id', 'highway', 'cycleway', 'lts', 'lts_change'])
      const rows = fields
        .filter((key: string) => props[key] !== undefined && props[key] !== null && props[key] !== '')
        .map(
          (key: string) =>
            `<div><strong>${this.escape(key)}:</strong> ${this.escape(String(props[key]))}</div>`
        )
        .join('')
      if (!rows) {
        this.tooltipHtml = ''
        return
      }
      this.tooltipHtml = rows
      this.tooltipStyle = {
        left: `${event.point.x + 14}px`,
        top: `${event.point.y + 14}px`,
      }
    },

    escape(value: string): string {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    },
  },
})
</script>

<style scoped lang="scss">
@import '@/styles.scss';

.vector-map {
  position: absolute;
  inset: 0;
  background: #f6f6f9;
}

.map-container {
  position: absolute;
  inset: 0;
}

.status-box {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid #e5e5e8;
  border-radius: 8px;
  font-size: 0.85rem;
  color: #171c60;
}

.map-legend {
  position: absolute;
  top: 10px;
  left: 10px;
  max-width: 220px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #e5e5e8;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(23, 28, 96, 0.1);
}

.legend-title {
  margin: 0 0 6px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #6b7080;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 3px 0;
  font-size: 0.72rem;
  color: #171c60;
}

.swatch {
  width: 16px;
  height: 4px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.map-controls {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #e5e5e8;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(23, 28, 96, 0.1);
}

.segmented {
  display: flex;
  align-self: flex-start;
  border: 1px solid #d9d9e0;
  border-radius: 6px;
  overflow: hidden;
}

.segmented button {
  border: 0;
  padding: 4px 8px;
  background: #fff;
  color: #171c60;
  font-size: 0.7rem;
  cursor: pointer;
}

.segmented button.active {
  background: #171c60;
  color: #fff;
}

.opacity {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.68rem;
  color: #6b7080;
}

.opacity input {
  width: 110px;
  height: 16px;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}

/* Visible grey track so the control reads as a slider, not a lone dot. */
.opacity input::-webkit-slider-runnable-track {
  height: 4px;
  background: #cfd2da;
  border-radius: 2px;
}

.opacity input::-moz-range-track {
  height: 4px;
  background: #cfd2da;
  border-radius: 2px;
}

.opacity input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border-radius: 50%;
  background: #171c60;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #cfd2da;
}

.opacity input::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #171c60;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #cfd2da;
}

.map-tooltip {
  position: absolute;
  z-index: 5;
  max-width: 260px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid #e5e5e8;
  border-radius: 7px;
  box-shadow: 0 3px 12px rgba(23, 28, 96, 0.14);
  font-size: 0.72rem;
  line-height: 1.4;
  color: #171c60;
  pointer-events: none;
}

.map-tooltip strong {
  color: #171c60;
}
</style>
