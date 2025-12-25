const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { query } = JSON.parse(event.body);

    // 1. 키워드 검색 먼저
    const { data: keywordDocs, error: keywordError } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .textSearch('content', query.split(' ').join(' & '))
      .limit(5);

    // 2. 키워드 검색 실패하면 ILIKE로 시도
    let keywordResults = keywordDocs || [];
    if (keywordResults.length === 0) {
      const { data: ilikeDocs } = await supabase
        .from('documents')
        .select('id, content, metadata')
        .ilike('content', `%${query.split(' ')[0]}%`)
        .limit(5);
      keywordResults = ilikeDocs || [];
    }

    // 3. 벡터 검색
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: query,
        model: 'text-embedding-3-small'
      })
    });

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    const { data: vectorDocs } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 10
    });

    // 4. 결과 합치기 (키워드 우선)
    const seenIds = new Set();
    const combined = [];
    
    for (const doc of keywordResults) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        combined.push(doc);
      }
    }
    
    if (vectorDocs) {
      for (const doc of vectorDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          combined.push(doc);
        }
      }
    }

    const documents = combined.slice(0, 10);

    if (!documents || documents.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: '관련된 기록을 찾지 못했습니다.',
          sources: []
        })
      };
    }

    // 5. Claude 분석
    const context = documents.map((doc, i) => {
      const m = doc.metadata || {};
      return `[문서 ${i+1}] 유형: ${m.meeting_type || '기타'} | 날짜: ${m.date || ''}\n${doc.content}`;
    }).join('\n\n---\n\n');

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `당신은 정부 회의 기록 분석 전문가입니다.

검색어: "${query}"

관련 문서:
"""
${context}
"""

위 문서에서 검색어와 관련된 내용을 찾아 요약해주세요. 누가 무슨 발언을 했는지 구체적으로 인용해주세요.`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer,
        sources: documents.map(d => d.metadata)
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
