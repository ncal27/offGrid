import { Season } from './types';

/** New England seasons by month: Dec–Feb winter, Mar–May spring, Jun–Aug summer, Sep–Nov fall. */
export function seasonOf(date: Date): Season {
  const m = date.getUTCMonth();
  if (m === 11 || m <= 1) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'fall';
}
