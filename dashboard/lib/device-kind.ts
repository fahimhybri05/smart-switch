/** Device artwork kinds — same set and name keywords as the mobile app's
 * DeviceVisualKind.fromName (app/lib/screens/shared/device_visualization.dart),
 * so a switch named "Bedroom Light" looks the same on both. */
export type DeviceKind =
  | 'switch'
  | 'plug'
  | 'socket'
  | 'light'
  | 'ledStrip'
  | 'fishTank'
  | 'fan'
  | 'multiPlug'
  | 'tv'
  | 'router'
  | 'pump'
  | 'motor'
  | 'appliance';

export function deviceKindFromName(name: string): DeviceKind {
  const v = name.toLowerCase();
  if (v.includes('led') || v.includes('strip')) return 'ledStrip';
  if (v.includes('fish') || v.includes('tank') || v.includes('aquarium')) return 'fishTank';
  if (v.includes('pump') || v.includes('water')) return 'pump';
  if (v.includes('motor')) return 'motor';
  if (v.includes('fan')) return 'fan';
  if (v.includes('multi') || v.includes('power strip')) return 'multiPlug';
  if (v.includes('tv') || v.includes('television')) return 'tv';
  if (v.includes('router') || v.includes('wifi')) return 'router';
  if (v.includes('plug')) return 'plug';
  if (v.includes('socket') || v.includes('outlet')) return 'socket';
  if (v.includes('light') || v.includes('lamp') || v.includes('bulb')) return 'light';
  if (v.includes('switch') || v.includes('relay')) return 'switch';
  return 'appliance';
}
