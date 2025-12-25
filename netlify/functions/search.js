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

    // 1. 키워드 검색 (단순 ILIKE)
    const { data: keywordDocs } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .ilike('content', `%${query}%`)
      .limit(10);

    // 2. 벡터 검색
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

    // 3. 키워드 결과 먼저, 그 다음 벡터 결과
    const seenIds = new Set();
    const documents = [];
    
    // 키워드 매칭 먼저
    if (keywordDocs) {
      for (const doc of keywordDocs) {
        seenIds.add(doc.id);
        documents.push(doc);
      }
    }
    
    // 벡터 결과 추가 (중복 제외)
    if (vectorDocs) {
      for (const doc of vectorDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          documents.push(doc);
        }
      }
    }

    if (documents.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: '관련된 기록을 찾지 못했습니다.',
          sources: []
        })
      };
    }

    // 4. Claude 분석
    const context = documents.slice(0, 8).map((doc, i) => {
      const m = doc.metadata || {};
      return `[문서 ${i+1}] 유형: ${m.meeting_type} | 날짜: ${m.date} | 출처: ${m.source}\n${doc.content}`;
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
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `검색어: "${query}"

아래 문서들을 분석해서 검색어와 관련된 내용을 찾아 답변해주세요.

문서:
${context}

요청:
1. 검색어가 포함된 문장을 그대로 인용해주세요
2. 누가 어떤 발언을 했는지 알려주세요
3. 핵심 내용을 요약해주세요`
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
        sources: documents.slice(0, 8).map(d => d.metadata)
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
