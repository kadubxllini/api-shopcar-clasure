// Shopcar ad parser — plain JavaScript, no imports.
//
// It runs inside the Chromium page (where DOMParser exists), so it must stay
// dependency-free and self-contained. `server.mjs` injects this file and
// rewrites the export line below into a `globalThis.shopcarParser` assignment.
// Keep that exact export line and do not add imports.

function parseShopcarHtml(html, originalUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 1. MARCA
  let brand = '';
  const marcaEl = doc.querySelector('.marca') || doc.querySelector('[class*="marca"]');
  if (marcaEl && marcaEl.textContent) {
    brand = marcaEl.textContent.trim();
  } else {
    const marcaRegex = html.match(/<span[^>]*class="marca"[^>]*>([^<]+)<\/span>/i);
    if (marcaRegex) brand = marcaRegex[1].trim();
  }
  
  if (brand) {
    brand = brand
      .replace(/.*-\s*/, '')
      .toLowerCase()
      .replace(/\b\w/g, char => char.toUpperCase());
  } else {
    const knownBrands = [
      'Chevrolet', 'Volkswagen', 'Fiat', 'Ford', 'Toyota', 'Hyundai', 
      'Honda', 'Jeep', 'Nissan', 'Renault', 'Mitsubishi', 'BMW', 
      'Mercedes-Benz', 'Audi', 'Peugeot', 'Citroën', 'RAM', 'Porsche', 'Volvo', 'BYD', 'Chery'
    ];
    for (const kb of knownBrands) {
      if (originalUrl.toLowerCase().includes(kb.toLowerCase()) || html.toLowerCase().includes(kb.toLowerCase())) {
        brand = kb;
        break;
      }
    }
  }

  // 2. VERSÃO COMPLETA (Título do Anúncio no Shopcar)
  let version = '';
  const modeloEl = doc.querySelector('.modelo');
  if (modeloEl && modeloEl.textContent) {
    version = modeloEl.textContent.trim();
  } else {
    const modeloRegex = html.match(/<span[^>]*class="modelo"[^>]*>([^<]+)<\/span>/i);
    if (modeloRegex) {
      version = modeloRegex[1].trim();
    } else {
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      if (ogTitle) {
        version = ogTitle.replace(/-\s*Campo Grande.*/i, '').replace(/-\s*SHOPCAR.*/i, '').trim();
      }
    }
  }

  // 4. PREÇO DO VEÍCULO (Estritamente da área principal do anúncio)
  let price = 0;
  
  const barraPrecoEl = doc.querySelector('.barra-preco') || 
                       doc.querySelector('.preco-detalhes') || 
                       doc.querySelector('.preco-veiculo') || 
                       doc.querySelector('.box-preco') || 
                       doc.querySelector('.preco');
                       
  let priceText = barraPrecoEl ? (barraPrecoEl.textContent || '') : '';

  if (!priceText) {
    const barraMatch = html.match(/class="(?:barra-preco|preco-detalhes|preco)"[^>]*>([\s\S]*?)<\/div>/i);
    if (barraMatch) {
      priceText = barraMatch[1];
    }
  }

  if (priceText) {
    const textUpper = priceText.toUpperCase();
    // Se for "Sob Consulta", "Consulte" ou "A combinar", zera o preço para exibir "Sob Consulta" no site
    if (textUpper.includes('CONSULTA') || textUpper.includes('CONSULTE') || textUpper.includes('COMBINAR')) {
      price = 0;
    } else {
      const match = priceText.match(/R\$\s*([\d\.]+,\d{2})/i) || priceText.match(/R\$\s*([\d\.]+)/i);
      if (match && match[1]) {
        price = parseFloat(match[1].replace(/\./g, '').replace(',', '.')) || 0;
      }
    }
  }

  // Se não houver bloco de texto, tenta a meta tag específica da página (sem escanear outros carros no HTML)
  if (!price && !priceText) {
    const ogPrice = doc.querySelector('meta[property="og:price:amount"]')?.getAttribute('content');
    if (ogPrice) {
      const parsed = parseFloat(ogPrice.replace(',', '.'));
      if (!isNaN(parsed) && parsed > 0) {
        price = parsed;
      }
    }
  }

  // 5. ANO / MODELO
  let yearModel = '2023/2023';
  const anoEl = doc.querySelector('.caract-anomodelo');
  const anoText = anoEl ? anoEl.textContent : html;
  const anoMatch = anoText?.match(/(\d{2,4}\/\d{2,4})/);
  if (anoMatch && anoMatch[1]) {
    const parts = anoMatch[1].split('/');
    if (parts.length === 2) {
      const formatYear = (yStr) => {
        if (yStr.length === 4) return yStr;
        if (yStr.length === 2) {
          const num = parseInt(yStr, 10);
          const currentYear = new Date().getFullYear();
          const max21stTwoDigit = (currentYear + 1) % 100;
          return num > max21stTwoDigit ? `19${yStr}` : `20${yStr}`;
        }
        return yStr;
      };
      const y1 = formatYear(parts[0]);
      const y2 = formatYear(parts[1]);
      yearModel = `${y1}/${y2}`;
    } else {
      yearModel = anoMatch[1];
    }
  }

  // 6. COR
  let color = 'Não informada';
  const corEl = doc.querySelector('.caract-cor');
  if (corEl && corEl.textContent) {
    color = corEl.textContent.replace(/Cor/i, '').trim();
  } else {
    const corMatch = html.match(/class="caract-cor"[^>]*>[\s\S]*?<\/span>\s*([^<]+)<\/div>/i);
    if (corMatch) color = corMatch[1].trim();
  }

  // 7. COMBUSTÍVEL
  let fuel = 'Flex';
  const combustEl = doc.querySelector('.caract-combust');
  const combustText = (combustEl ? combustEl.textContent : html) || '';
  const textUpper = combustText.toUpperCase();
  if (textUpper.includes('DIESEL')) fuel = 'Diesel';
  else if (textUpper.includes('GASOLINA')) fuel = 'Gasolina';
  else if (textUpper.includes('HÍBRIDO') || textUpper.includes('HIBRIDO')) fuel = 'Híbrido';
  else if (textUpper.includes('ELÉTRICO') || textUpper.includes('ELETRICO')) fuel = 'Elétrico';
  else fuel = 'Flex';

  // 8. CÂMBIO
  let transmission = 'Manual';
  const cambioEl = doc.querySelector('.caract-cambio');
  const cambioText = (cambioEl ? cambioEl.textContent : html) || '';
  const cambioUpper = cambioText.toUpperCase();
  if (cambioUpper.includes('CVT')) {
    transmission = 'CVT';
  } else if (cambioUpper.includes('AUTOMÁTICO') || cambioUpper.includes('AUTOMATICO') || cambioUpper.includes('AUTO')) {
    transmission = 'Automático';
  } else {
    transmission = 'Manual';
  }

  // 9. QUILOMETRAGEM (KM)
  let mileage;
  const kmEl = doc.querySelector('.caract-km');
  const kmText = kmEl ? kmEl.textContent : html;
  const kmMatch = kmText?.match(/([\d\.]+)\s*Km/i);
  if (kmMatch && kmMatch[1]) {
    const parsed = parseInt(kmMatch[1].replace(/\./g, ''), 10);
    if (!isNaN(parsed)) {
      mileage = parsed;
    }
  }

  // 10. EXTRAÇÃO DE FOTOS (Estritamente da galeria do veículo)
  const photos = [];
  
  // Método 1: Galeria DOM do anúncio (.dv-imagens)
  const fotoElements = doc.querySelectorAll('.dv-imagens a.fotogroup, .dv-imagens .first-imagem a, .dv-imagens .miniaturas a img, .dv-imagens img');
  fotoElements.forEach(el => {
    let href = el.getAttribute('href') || el.getAttribute('data-id') || el.getAttribute('src');
    if (href) {
      if (!href.startsWith('http')) {
        href = 'https://cdn.shopcar.com.br' + (href.startsWith('/') ? '' : '/') + href;
      }
      let fullResUrl = href.replace(/\/redim\/\d+\//, '/').replace(/pd\.jpg$/i, '.jpg').trim();
      if (fullResUrl.includes('stored/veiculos/') || fullResUrl.includes('/veiculos/')) {
        if (!fullResUrl.includes('foto_indisponivel') && !fullResUrl.includes('logo') && !photos.includes(fullResUrl)) {
          photos.push(fullResUrl);
        }
      }
    }
  });

  // Método 2: Regex focado exclusivamente no diretório /veiculos/ do CDN
  if (photos.length === 0) {
    const vehicleSectionHtml = html.split(/Ofertas da categoria|<div id="box-destaque"|<div id="anunciante"/i)[0] || html;
    const rawPhotoMatches = vehicleSectionHtml.match(/https?:\/\/[^"'\s\)]+(?:stored|fotos|images)\/veiculos\/[^"'\s\)]+\.(?:jpg|png|webp|jpeg)/gi) || [];
    
    rawPhotoMatches.forEach(url => {
      let cleanUrl = url.replace(/["'>].*$/, '').trim();
      if (cleanUrl.includes('/redim/135/') || cleanUrl.includes('/redim/90/') || cleanUrl.includes('/redim/55/')) return;
      if (cleanUrl.includes('/lojas/') || cleanUrl.includes('stored/lojas') || cleanUrl.includes('logo') || cleanUrl.includes('banner') || cleanUrl.includes('icone') || cleanUrl.includes('foto_indisponivel') || cleanUrl.includes('semfoto')) return;

      let fullResUrl = cleanUrl.replace(/\/redim\/\d+\//, '/').replace(/pd\.jpg$/i, '.jpg');
      if (!photos.includes(fullResUrl)) {
        photos.push(fullResUrl);
      }
    });
  }

  if (photos.length === 0) {
    const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
    if (ogImage && (ogImage.includes('stored/veiculos/') || ogImage.includes('/veiculos/')) && !ogImage.includes('logo') && !ogImage.includes('foto_indisponivel')) {
      photos.push(ogImage);
    }
  }

  // 11. OPCIONAIS
  const features = [];
  const opcionaisList = doc.querySelectorAll('.opcionais li');
  if (opcionaisList.length > 0) {
    opcionaisList.forEach(li => {
      const text = li.textContent?.replace('•', '').trim();
      if (text) features.push(text);
    });
  } else {
    const opcionaisMatch = html.match(/<ul class="opcionais">([\s\S]*?)<\/ul>/i);
    if (opcionaisMatch) {
      const liMatches = opcionaisMatch[1].match(/<li><span>•<\/span>([^<]+)<\/li>/gi) || [];
      liMatches.forEach(li => {
        const txt = li.replace(/<li><span>•<\/span>/i, '').replace(/<\/li>/i, '').trim();
        if (txt) features.push(txt);
      });
    }
  }

  const maisOpMatch = html.match(/Mais opcionais:[\s\S]*?<span class="desc-dados">([^<]+)<\/span>/i);
  if (maisOpMatch && maisOpMatch[1].trim()) {
    features.push(`Mais opcionais: ${maisOpMatch[1].trim()}`);
  }

  // 12. OBSERVAÇÕES DO ANUNCIANTE
  let description = '';
  const obsMatch = html.match(/Observações do anunciante:[\s\S]*?<span class="desc-dados">([^<]+)<\/span>/i);
  if (obsMatch && obsMatch[1]) {
    description = obsMatch[1].trim();
  }

  // 13. INFERÊNCIA INTELIGENTE DE CARROCERIA (Hatch, Sedan, SUV, Picape, Cupê, Minivan, Outros)
  let bodyType = 'Outros';
  const htmlCarroceriaMatch = html.match(/Carroceria:[\s\S]*?<span[^>]*>([^<]+)<\/span>/i) || html.match(/Carroceria[\s\S]*?<td[^>]*>([^<]+)<\/td>/i);
  if (htmlCarroceriaMatch && htmlCarroceriaMatch[1].trim()) {
    const rawType = htmlCarroceriaMatch[1].trim().toLowerCase();
    if (rawType.includes('suv') || rawType.includes('utilitário esportivo')) bodyType = 'SUV';
    else if (rawType.includes('sedan') || rawType.includes('sedã')) bodyType = 'Sedan';
    else if (rawType.includes('hatch')) bodyType = 'Hatch';
    else if (rawType.includes('picape') || rawType.includes('pickup') || rawType.includes('caminhonete')) bodyType = 'Picape';
    else if (rawType.includes('cupê') || rawType.includes('coupe') || rawType.includes('esportivo')) bodyType = 'Cupê';
    else if (rawType.includes('minivan') || rawType.includes('van')) bodyType = 'Minivan';
    else bodyType = 'Outros';
  } else {
    const textToTest = `${brand} ${version}`.toLowerCase();
    if (/suv|compass|renegade|commander|creta|tucson|tracker|t-cross|nivus|taos|tiguan|hr-v|wr-v|zr-v|cr-v|kicks|duster|captur|kardian|sw4|corolla cross|pulse|fastback|bronco|territory|equinox|trailblazer|q3|q5|q7|x1|x3|x5|glc|gla|gle|macan|cayenne/i.test(textToTest)) {
      bodyType = 'SUV';
    } else if (/picape|pickup|caminhonete|hilux|s10|ranger|toro|strada|amarok|saveiro|montana|oroch|l200|frontier|ram 1500|ram 2500|rampage|silverado|maverick|f-150/i.test(textToTest)) {
      bodyType = 'Picape';
    } else if (/sedan|sedã|corolla|civic|onix plus|virtus|city|sentra|jetta|cruze|cronos|hb20s|logan|voyage|siena|grand siena|yaris sedan|accord|camry|cerato|fusion|c180|c200|c300|320i|330i|a4|a3 sedan/i.test(textToTest)) {
      bodyType = 'Sedan';
    } else if (/hatch|onix|hb20|polo|gol|argo|fit|yaris|sandero|mobi|kwid|fox|up|uno|ka|c3|peugeot 208|golf|i20|cooper/i.test(textToTest)) {
      bodyType = 'Hatch';
    } else if (/minivan|van|furgão|fiorino|master|ducato|hr|sprinter|kombi|doblo|spin|partner|kangoo/i.test(textToTest)) {
      bodyType = 'Minivan';
    } else if (/cupê|coupe|mustang|camaro|tt|porsche 911|boxster|cayman|z4|r8|supra/i.test(textToTest)) {
      bodyType = 'Cupê';
    } else {
      bodyType = 'Outros';
    }
  }

  return {
    brand,
    model: version,
    version,
    yearModel,
    price,
    mileage,
    fuel,
    transmission,
    color,
    plateEnd: '0',
    photos: photos.length > 0 ? photos : [],
    features: features.length > 0 ? features : ['Ar Condicionado', 'Direção Elétrica', 'Freios ABS'],
    description,
    shopcarUrl: originalUrl,
    bodyType
  };
}

export { parseShopcarHtml };
