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

    // 1. 키워드 검색 (정확한 텍스트 매칭)
    const { data: keywordDocs } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .ilike('content', `%${query}%`)
      .limit(5);

    // 2. 벡터 검색 (의미적 유사도)
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

    const { data: vectorDocs, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 10
    });

    if (error) throw error;

    // 3. 결과 합치기 (키워드 검색 우선, 중복 제거)
    const seenIds = new Set();
    const combined = [];
    
    // 키워드 매칭 결과 먼저 추가
    if (keywordDocs) {
      for (const doc of keywordDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          combined.push(doc);
        }
      }
    }
    
    // 벡터 검색 결과 추가
    if (vectorDocs) {
      for (const doc of vectorDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          combined.push(doc);
        }
      }
    }

    const documents = combined.slice(0, 10);

    // 4. 검색 결과가 없으면
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

    // 5. Claude에게 분석 요청
    const context = documents.map((doc, i) => {
      const m = doc.metadata || {};
      const meetingType = m.meeting_type || '기타';
      const date = m.date || '';
      const sessionNum = m.session_num || '';
      const source = m.source || '';
      return `[문서 ${i+1}] 유형: ${meetingType} | 날짜: ${date} | 회차: ${sessionNum} | 출처: ${source}\n${doc.content}`;
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

아래는 사용자의 검색어입니다:
"""
${query}
"""

아래는 검색된 관련 문서입니다:
"""
${context}
"""

위 문서를 바탕으로:
1. 검색어와 관련된 내용을 찾아 요약해주세요.
2. 누가 어떤 발언을 했는지 구체적으로 인용해주세요.
3. 관련 정책이나 후속 조치가 언급되었다면 알려주세요.

문서 내용을 충실히 인용하여 답변해주세요.`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    // 6. 결과 반환
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
