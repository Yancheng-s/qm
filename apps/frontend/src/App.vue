<script setup lang="ts">
import Console from "./components/Console.vue";
</script>

<template>
  <Console />
</template>

<style>
:root {
  --bg: #0b0d10;
  --panel: #12161b;
  --panel2: #171c22;
  --line: #232a32;
  --text: #e6e9ec;
  --muted: #8b97a3;
  --accent: #4f8cff;
  --err: #ff6b6b;
}
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font:
    14px/1.55 ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    "PingFang SC",
    "Microsoft YaHei",
    sans-serif;
}
button {
  font: inherit;
  cursor: pointer;
}
input,
textarea,
select {
  font: inherit;
}
.field {
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  padding: 9px 12px;
}
.field:focus {
  outline: none;
  border-color: var(--accent);
}
.btn {
  background: var(--accent);
  border: none;
  border-radius: 8px;
  color: #fff;
  padding: 9px 16px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
