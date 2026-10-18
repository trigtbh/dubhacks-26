import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react';

createRoot(document.getElementById('stage')).render(
  <ShaderGradientCanvas style={{ position: 'absolute', inset: 0 }} pixelDensity={1} fov={45} pointerEvents="none" lazyLoad={false} preserveDrawingBuffer>
    <ShaderGradient
      animate="on"
      axesHelper="on"
      bgColor1="#000000"
      bgColor2="#000000"
      brightness={1.1}
      cAzimuthAngle={180}
      cDistance={3.9}
      cPolarAngle={115}
      cameraZoom={1}
      color1="#5606ff"
      color2="#fe8989"
      color3="#000000"
      destination="onCanvas"
      embedMode="off"
      envPreset="city"
      format="gif"
      fov={45}
      frameRate={10}
      gizmoHelper="hide"
      grain="off"
      lightType="3d"
      pixelDensity={1}
      positionX={-0.5}
      positionY={0.1}
      positionZ={0}
      range="disabled"
      rangeEnd={40}
      rangeStart={0}
      reflection={0.1}
      rotationX={0}
      rotationY={0}
      rotationZ={235}
      shader="defaults"
      type="waterPlane"
      uAmplitude={0}
      uDensity={1.1}
      uFrequency={5.5}
      uSpeed={0.1}
      uStrength={2.4}
      uTime={0.2}
      wireframe={false}
    />
  </ShaderGradientCanvas>
);

// Give it a few seconds to render, then send the canvas to capture.mjs.
setTimeout(async () => {
  const c = document.querySelector('#stage canvas');
  if (c.width !== 4096 || c.height !== 4096) return (document.title = `wrong size ${c.width}x${c.height}`);
  await fetch('/save', { method: 'POST', body: await new Promise((ok) => c.toBlob(ok, 'image/png')) });
  document.title = 'saved';
}, 4000);
