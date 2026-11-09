<template lang="pug">
vector-map.deck-map(
  :fileSystemConfig="fileSystemConfig"
  :subfolder="subfolder"
  :config="config"
  :datamanager="datamanager"
  @isLoaded="$emit('isLoaded')"
  @error="$emit('error', $event)"
)
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import VectorMap from '@/plugins/vector-map/VectorMap.vue'

export default defineComponent({
  name: 'VectorMapPanel',
  components: { VectorMap },
  props: {
    config: Object,
    datamanager: Object,
    fileSystemConfig: Object,
    subfolder: String,
    yamlConfig: String,
  },
})
</script>

<style scoped lang="scss">
.deck-map {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
}
</style>
