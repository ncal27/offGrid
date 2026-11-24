import { Router } from 'express';
import { getPromotedImage } from '../services/landmarkPhotoService';

export const photosRouter = Router();

/**
 * Promoted hiker photos, so phones can download them as reference photos
 * (the "good photos reinforce the trail" loop). Only promoted photos exist
 * here; pending ones 404 like unknown ids. The name is validated before use.
 */
photosRouter.get('/:file', (req, res) => {
  const match = /^(promoted-[A-Za-z0-9_-]{1,128})\.jpg$/.exec(req.params.file);
  const image = match ? getPromotedImage(match[1]) : null;
  if (!image) {
    res.status(404).json({ error: 'photo_not_found' });
    return;
  }
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.send(image);
});
