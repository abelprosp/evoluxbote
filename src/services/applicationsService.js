const { getSupabase } = require('../db/supabase');

async function saveWhatsappApplication(app) {
  const supabase = getSupabase();

  const BUCKET_NAME = 'resumes';

  const base64 = app.resumeBase64 || '';
  const buffer = Buffer.from(base64, 'base64');
  const size = buffer.length;

  const safeFileName = (app.resumeFilename || 'curriculo').replace(/[^\w.\-]+/g, '_');
  const key = `${app.chatId || 'unknown'}/${Date.now()}-${safeFileName}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(key, buffer, {
      contentType: app.resumeMimetype || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`SupabaseStorageError: ${uploadError.message}`);
  }

  const filePath = key;
  const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(key);
  const fileUrl = publicUrlData?.publicUrl || null;

  const payload = {
    candidate_name: app.fullName,
    candidate_phone: app.whatsappNumber,
    candidate_email: app.email || null,
    file_name: app.resumeFilename,
    file_path: filePath,
    file_size: size,
    file_type: app.resumeMimetype,
    file_url: fileUrl,
    city: app.city,
    position_of_interest: app.jobInterest,
  };

  const { data, error } = await supabase.from('resumes').insert([payload]).select().single();

  if (error) {
    throw new Error(`SupabaseError: ${error.message}`);
  }

  return data;
}

module.exports = {
  saveWhatsappApplication,
};
