export function createImageFill(
  pngBytes: Uint8Array,
  node: RectangleNode | FrameNode
): void {
  const image = figma.createImage(pngBytes);
  node.fills = [
    {
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: 'FILL',
    },
  ];
}
