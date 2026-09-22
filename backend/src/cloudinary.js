// backend/src/cloudinary.js
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

/**
 * Upload a buffer to Cloudinary.
 * Simplified — no use_filename or unique_filename to avoid signature issues.
 */
function uploadBuffer(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: opts.folder || 'nexora/uploads',
                resource_type: opts.resource_type || 'auto',
                // ⚠️ Removed: use_filename, unique_filename, overwrite
                // These can cause signature mismatches on some SDK versions
            },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        );
        Readable.from(buffer).pipe(uploadStream);
    });
}

async function deleteAsset(publicId, resourceType = 'image') {
    try {
        return await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (e) {
        console.error('[cloudinary:delete]', e.message);
        return null;
    }
}

module.exports = { cloudinary, uploadBuffer, deleteAsset };
