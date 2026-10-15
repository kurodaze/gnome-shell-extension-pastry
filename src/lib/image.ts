import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

/**
 * Loads an image that fits in `maxWidth` x `maxHeight` while keeping its
 * aspect ratio. St sizes the actor to exactly the box it is asked for, so
 * the box has to be fitted to the image first or the image gets stretched.
 */
export function loadImage(
    file: Gio.File, maxWidth: number, maxHeight: number, resourceScale: number, upscale: boolean
): Clutter.Actor {
    let width = maxWidth;
    let height = maxHeight;
    const [, imageWidth, imageHeight] = GdkPixbuf.Pixbuf.get_file_info(file.get_path()!);
    if (imageWidth > 0 && imageHeight > 0) {
        const ratio = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, upscale ? Infinity : 1);
        width = Math.max(1, Math.round(imageWidth * ratio));
        height = Math.max(1, Math.round(imageHeight * ratio));
    }

    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const actor = St.TextureCache.get_default().load_file_async(file, width, height, scale, resourceScale);
    // Unknown sizes fall back to the full box, so at least keep the shape
    actor.content_gravity = Clutter.ContentGravity.RESIZE_ASPECT;
    return actor;
}
