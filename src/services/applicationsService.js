const { getSupabase } = require('../db/supabase');
const { PDFDocument } = require('pdf-lib');

/**
 * Normaliza número de telefone para apenas dígitos (remove @s.whatsapp.net, @lid, @g.us, etc.).
 * Se o número tiver mais de 13 dígitos e começar com 55 (Brasil), mantém só 55 + DDD + 9 dígitos
 * (padrão celular BR), para evitar gravar sufixos vindos do WhatsApp (ex.: @lid).
 */
function normalizePhoneForDb(whatsappNumberOrChatId) {
  if (!whatsappNumberOrChatId || typeof whatsappNumberOrChatId !== 'string') return null;
  const digits = whatsappNumberOrChatId.replace(/\D/g, '');
  if (digits.length === 0) return null;
  // Brasil: 55 + 2 (DDD) + 8 ou 9 = 12 ou 13 dígitos. Se veio maior (ex.: chatId com @lid), corta para 13.
  if (digits.startsWith('55') && digits.length > 13) return digits.slice(0, 13);
  return digits;
}

/**
 * Converte buffer de imagem (JPEG/PNG) em PDF para upload em bucket que só aceita application/pdf.
 */
async function imageBufferToPdf(buffer) {
  const pdfDoc = await PDFDocument.create();
  const uint8 = new Uint8Array(Buffer.isBuffer(buffer) ? buffer : buffer);
  const isPng = uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e;
  const image = isPng
    ? await pdfDoc.embedPng(uint8)
    : await pdfDoc.embedJpg(uint8);
  const { width, height } = image.scaleToFit(595, 842);
  const page = pdfDoc.addPage([595, 842]);
  page.drawImage(image, { x: (595 - width) / 2, y: 842 - height - 72, width, height });
  return Buffer.from(await pdfDoc.save());
}

/**
 * Salva candidatura na tabela `resumes` e, se houver currículo, faz upload no bucket `resumes`.
 * Se não houver arquivo (base64 vazio), salva só os dados do candidato (file_* ficam null/vazios).
 * Imagens são convertidas para PDF antes do upload se o bucket só aceitar application/pdf.
 */
async function saveWhatsappApplication(app) {
  const supabase = getSupabase();
  const BUCKET_NAME = 'resumes';

  const base64 = app.resumeBase64 || '';
  let buffer = Buffer.from(base64, 'base64');
  const size = buffer.length;
  const hasFile = base64.length > 0 && size > 0;

  let filePath = null;
  let fileUrl = null;
  let fileName = app.resumeFilename || null;
  const fileType = app.resumeMimetype || null;
  let finalFileSize = size;

  if (hasFile) {
    const realMimetype = app.resumeMimetype || (app.resumeFilename || '').match(/\.(jpg|jpeg|png|webp)$/i) ? 'image/jpeg' : 'application/octet-stream';
    let uploadBuffer = buffer;
    let uploadContentType = realMimetype;
    let safeFileName = (app.resumeFilename || 'curriculo').replace(/[^\w.\-]+/g, '_');

    if (realMimetype.startsWith('image/')) {
      try {
        uploadBuffer = await imageBufferToPdf(buffer);
        uploadContentType = 'application/pdf';
        safeFileName = 'curriculo.pdf';
        fileName = fileName || 'curriculo.pdf';
        finalFileSize = uploadBuffer.length;
        console.log(`[Applications] Imagem convertida para PDF (${uploadBuffer.length} bytes) para upload.`);
      } catch (e) {
        console.warn('[Applications] Falha ao converter imagem para PDF, tentando upload direto:', e?.message);
      }
    }

    const key = `${(app.chatId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')}/${Date.now()}-${safeFileName}`;

    console.log(`[Applications] Enviando currículo para storage: ${key} (${uploadBuffer.length} bytes, ${uploadContentType})`);
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(key, uploadBuffer, {
        contentType: uploadContentType,
        upsert: false,
      });

    if (uploadError) {
      console.error('[Applications] Erro no upload do currículo:', uploadError.message, uploadError);
      throw new Error(`SupabaseStorageError: ${uploadError.message}`);
    }

    filePath = key;
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(key);
    fileUrl = publicUrlData?.publicUrl || null;
    console.log('[Applications] Upload do currículo concluído.');
  } else {
    console.log('[Applications] Candidatura sem arquivo de currículo; salvando apenas dados do candidato.');
  }

  const candidatePhone = normalizePhoneForDb(app.whatsappNumber) || normalizePhoneForDb(app.chatId) || null;

  const payload = {
    candidate_name: app.fullName,
    candidate_phone: candidatePhone,
    candidate_email: app.email || null,
    file_name: fileName,
    file_path: filePath,
    file_size: hasFile ? finalFileSize : null,
    file_type: fileType,
    file_url: fileUrl,
    city: app.city,
    position_of_interest: app.jobInterest,
  };

  console.log('[Applications] Inserindo na tabela resumes:', { candidate_name: payload.candidate_name, candidate_phone: payload.candidate_phone, candidate_email: payload.candidate_email });
  const { data, error } = await supabase.from('resumes').insert([payload]).select().single();

  if (error) {
    console.error('[Applications] Erro ao inserir em resumes:', error.message, error.details || error);
    throw new Error(`SupabaseError: ${error.message}`);
  }

  console.log('[Applications] Candidatura salva com sucesso. id:', data?.id);
  return data;
}

module.exports = {
  saveWhatsappApplication,
  normalizePhoneForDb,
};
