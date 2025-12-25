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
    
    if (keywordDocs) {
      for (const doc of keywordDocs) {
        seenIds.add(doc.id);
        documents.push(doc);
      }
    }
    
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
    const context = documents.slice(0, 10).map((doc, i) => {
      const m = doc.metadata || {};
      return `[문서 ${i+1}] 유형: ${m.meeting_type || '기타'} | 날짜: ${m.date || '미상'} | 출처: ${m.source || ''} | 회차: ${m.session_num || ''}\n${doc.content}`;
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
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `검색어: "${query}"

아래는 검색된 정부 회의 기록입니다:

${context}

위 문서들을 분석해서 다음을 수행해주세요:

1. **검색어와 직접 관련된 내용이 있는 문서를 모두 찾아주세요.**

2. **각 관련 문서마다 다음을 상세하게 설명해주세요:**
   - 어떤 회의인지 (날짜, 유형)
   - 발언자가 누구인지
   - 무슨 내용을 말했는지 (원문 인용 포함)
   - 그 발언의 맥락과 배경
   - 관련 정책이나 후속 조치

3. **관련된 다른 논의나 연관 주제도 있다면 함께 설명해주세요.**

4. **전체적인 핵심 요약을 마지막에 정리해주세요.**

각 문서를 빠짐없이 분석하고, 검색어와 관련된 모든 내용을 상세하게 설명해주세요.`
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
        sources: documents.slice(0, 10).map(d => d.metadata)
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
