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

/** Magic bytes: PNG, JPEG, WebP, GIF */
function getImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const u = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'png';
  if (u[0] === 0xff && u[1] === 0xd8) return 'jpeg';
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return 'webp';
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return 'gif';
  return null;
}

/**
 * Converte buffer de imagem (JPEG/PNG) em PDF para upload em bucket que só aceita application/pdf.
 * Só use com buffers já identificados como JPEG ou PNG (ex.: por getImageFormat).
 */
async function imageBufferToPdf(buffer) {
  const pdfDoc = await PDFDocument.create();
  const uint8 = new Uint8Array(Buffer.isBuffer(buffer) ? buffer : buffer);
  const isPng = getImageFormat(buffer) === 'png';
  const image = isPng
    ? await pdfDoc.embedPng(uint8)
    : await pdfDoc.embedJpg(uint8);
  const { width, height } = image.scaleToFit(595, 842);
  const page = pdfDoc.addPage([595, 842]);
  page.drawImage(image, { x: (595 - width) / 2, y: 842 - height - 72, width, height });
  return Buffer.from(await pdfDoc.save());
}

/**
 * Converte qualquer imagem (WebP, JPEG, PNG, etc.) para JPEG usando sharp e depois para PDF.
 * Assim o currículo real (a imagem) é enviado ao storage em formato PDF.
 */
async function imageToPdfWithSharp(buffer) {
  const sharp = require('sharp');
  const jpegBuffer = await sharp(buffer)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return imageBufferToPdf(jpegBuffer);
}

/**
 * Salva candidatura na tabela `resumes` e, se houver currículo, faz upload no bucket `resumes`.
 * Se não houver arquivo (base64 vazio), salva só os dados do candidato (file_* ficam null/vazios).
 * Imagens são convertidas para PDF antes do upload se o bucket só aceitar application/pdf.
 */
async function saveWhatsappApplication(app) {
  const supabase = getSupabase();
  const BUCKET_NAME = 'resumes';

  let base64 = (app.resumeBase64 || '').trim();
  if (base64.startsWith('data:') && base64.includes(',')) base64 = base64.slice(base64.indexOf(',') + 1);
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

    if (buffer.length >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      uploadContentType = 'application/pdf';
      if (!safeFileName.toLowerCase().endsWith('.pdf')) safeFileName = safeFileName.replace(/\.[^.]+$/, '') + '.pdf';
      fileName = fileName || 'curriculo.pdf';
    } else if (realMimetype.startsWith('image/')) {
      const format = getImageFormat(buffer);
      console.log('[Applications] Formato detectado (magic bytes):', format || 'desconhecido', 'tamanho:', buffer.length);

      try {
        // 1) Tenta Sharp primeiro (WebP, PNG, JPEG, GIF, etc.) – evita "SOI not found" em WebP
        uploadBuffer = await imageToPdfWithSharp(buffer);
        uploadContentType = 'application/pdf';
        safeFileName = 'curriculo.pdf';
        fileName = fileName || 'curriculo.pdf';
        finalFileSize = uploadBuffer.length;
        console.log(`[Applications] Imagem convertida para PDF via sharp (${uploadBuffer.length} bytes) – currículo real.`);
      } catch (sharpErr) {
        console.warn('[Applications] Sharp não disponível ou falhou:', sharpErr?.message);
        try {
          // 2) Só usa pdf-lib para JPEG/PNG (evita embedJpg com WebP)
          if (format === 'jpeg' || format === 'png') {
            uploadBuffer = await imageBufferToPdf(buffer);
            uploadContentType = 'application/pdf';
            safeFileName = 'curriculo.pdf';
            fileName = fileName || 'curriculo.pdf';
            finalFileSize = uploadBuffer.length;
            console.log(`[Applications] Imagem convertida para PDF (pdf-lib) (${uploadBuffer.length} bytes).`);
          } else {
            throw new Error('Formato não suportado sem sharp');
          }
        } catch (e) {
          console.warn('[Applications] Fallback pdf-lib falhou:', e?.message);
          try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage([595, 842]);
            page.drawText('Currículo enviado como imagem. Arquivo original anexado na candidatura.', {
              x: 50,
              y: 800,
              size: 12,
            });
            uploadBuffer = Buffer.from(await pdfDoc.save());
            uploadContentType = 'application/pdf';
            safeFileName = 'curriculo.pdf';
            fileName = fileName || 'curriculo.pdf';
            finalFileSize = uploadBuffer.length;
            console.log('[Applications] Upload com PDF substituto (instale sharp para enviar a imagem real).');
          } catch (fallbackErr) {
            console.error('[Applications] Erro ao criar PDF:', fallbackErr?.message);
            throw new Error('Não foi possível preparar o currículo para envio. Tente enviar em PDF.');
          }
        }
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

/**
 * Verifica se já existe candidatura na tabela `resumes` para o telefone derivado do chat WhatsApp.
 * @param {string} chatIdOrDigits remoteJid ou só dígitos
 * @returns {Promise<boolean>}
 */
async function hasResumeRegisteredForPhone(chatIdOrDigits) {
  const phone = normalizePhoneForDb(chatIdOrDigits);
  if (!phone) return false;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('resumes').select('id').eq('candidate_phone', phone).limit(1);
  if (error) {
    console.error('[Applications] hasResumeRegisteredForPhone:', error.message);
    throw new Error(error.message);
  }
  return Array.isArray(data) && data.length > 0;
}

module.exports = {
  saveWhatsappApplication,
  normalizePhoneForDb,
  hasResumeRegisteredForPhone,
};
