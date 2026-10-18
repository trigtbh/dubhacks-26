import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShaderGradientCanvas, ShaderGradient, presets } from '@shadergradient/react';
/* Crystal wrapper around ShaderGradient (MIT, ruucm). mount(el, props) renders a gradient
   into el; props are ShaderGradient props. Returns { stop }. */
function mount(el, props) {
  const root = createRoot(el);
  root.render(
    <ShaderGradientCanvas style={{ position: 'absolute', inset: 0 }} pixelDensity={props.pixelDensity || 1} fov={45} pointerEvents="none" lazyLoad={false} preserveDrawingBuffer>
      <ShaderGradient control="props" {...props} />
    </ShaderGradientCanvas>
  );
  return { stop: () => root.unmount() };
}
window.CrystalGradient = { mount, presets };
