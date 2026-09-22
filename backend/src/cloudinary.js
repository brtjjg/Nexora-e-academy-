// backend/src/cloudinary.js
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Configure from env vars (set on Render)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer - file contents
 * @param {Object} opts - { folder, filename, resource_type, transformation }
 * @returns {Promise<{ url, secure_url, public_id, format, bytes }>}
 */
function uploadBuffer(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: opts.folder || 'nexora/uploads',
                public_id: opts.public_id || undefined,
                resource_type: opts.resource_type || 'auto',
                use_filename: true,
                unique_filename: true,
                overwrite: false,
            },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        );
        Readable.from(buffer).pipe(uploadStream);
    });
}

/**
 * Delete a Cloudinary asset by public_id.
 */
async function deleteAsset(publicId, resourceType = 'image') {
    try {
        return await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (e) {
        console.error('[cloudinary:delete]', e.message);
        return null;
    }
}

module.exports = { cloudinary, uploadBuffer, deleteAsset };
