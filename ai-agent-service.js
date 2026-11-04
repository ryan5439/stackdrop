// Stackdrop AI Agent Service (Server-Side)
// No client download needed - everything runs on the server!

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

class AIAgentService {
    constructor(io) {
        this.io = io;
        this.activeRooms = new Map(); // roomCode -> { userId, socket, session }
        this.setupSocketHandlers();
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log('Client connected:', socket.id);

            // Join AI Agent room
            socket.on('join_ai_agent', async (data) => {
                try {
                    const userId = data.userId; // From authenticated session
                    const roomCode = this.generateRoomCode();

                    // Create room in database
                    const { error } = await supabase
                        .from('ai_agent_rooms')
                        .insert([{
                            room_code: roomCode,
                            user_id: userId,
                            web_socket_id: socket.id,
                            web_connected: true,
                            status: 'connected',
                            pc_name: 'Server (Web-Based)'
                        }]);

                    if (error) {
                        console.error('Error creating room:', error);
                        socket.emit('error', { message: 'Failed to create room' });
                        return;
                    }

                    // Join socket room
                    socket.join(roomCode);
                    this.activeRooms.set(roomCode, {
                        userId,
                        socket,
                        session: null
                    });

                    // Send room info to client
                    socket.emit('room_registered', {
                        room_code: roomCode,
                        status: 'ready'
                    });

                    // Immediately mark as connected (no PC needed!)
                    socket.emit('agent_ready', {
                        message: 'AI Agent is ready! No download required.',
                        serverBased: true
                    });

                    console.log(`Room ${roomCode} created for user ${userId}`);

                } catch (error) {
                    console.error('Error in join_ai_agent:', error);
                    socket.emit('error', { message: 'Server error' });
                }
            });

            // Start AI task
            socket.on('start_agent', async (data) => {
                try {
                    const { goal, provider, api_key, room_code } = data;

                    if (!room_code || !this.activeRooms.has(room_code)) {
                        socket.emit('error', { message: 'Invalid room' });
                        return;
                    }

                    const room = this.activeRooms.get(room_code);

                    // Create session in database
                    const { data: session, error: sessionError } = await supabase
                        .from('ai_agent_sessions')
                        .insert([{
                            room_code: room_code,
                            user_id: room.userId,
                            goal: goal,
                            status: 'running',
                            ai_provider: provider || 'openai'
                        }])
                        .select()
                        .single();

                    if (sessionError) {
                        console.error('Error creating session:', sessionError);
                        socket.emit('error', { message: 'Failed to create session' });
                        return;
                    }

                    room.session = session;

                    // Send processing message
                    socket.emit('agent_response', {
                        type: 'log',
                        level: 'system',
                        message: 'Processing your request...'
                    });

                    // Call AI provider
                    await this.processAIRequest(socket, room_code, goal, provider, api_key, session.id);

                } catch (error) {
                    console.error('Error in start_agent:', error);
                    socket.emit('error', { message: 'Failed to process request' });
                }
            });

            // Emergency stop
            socket.on('emergency_stop', (data) => {
                const room_code = data.room_code;
                if (room_code && this.activeRooms.has(room_code)) {
                    socket.emit('agent_response', {
                        type: 'log',
                        level: 'system',
                        message: '⚠️ Emergency stop activated'
                    });
                }
            });

            // Disconnect
            socket.on('disconnect', async () => {
                console.log('Client disconnected:', socket.id);
                
                // Find and cleanup room
                for (const [roomCode, room] of this.activeRooms.entries()) {
                    if (room.socket.id === socket.id) {
                        await supabase
                            .from('ai_agent_rooms')
                            .update({ web_connected: false, status: 'disconnected' })
                            .eq('room_code', roomCode);

                        this.activeRooms.delete(roomCode);
                        break;
                    }
                }
            });
        });
    }

    async processAIRequest(socket, roomCode, goal, provider, apiKey, sessionId) {
        try {
            // Get user's AI provider config from database
            const room = this.activeRooms.get(roomCode);
            const { data: providerConfig } = await supabase
                .from('ai_agent_providers')
                .select('*')
                .eq('user_id', room.userId)
                .eq('provider_name', provider || 'openai')
                .single();

            let response;

            // Call appropriate AI provider
            if (provider === 'openai' || !provider) {
                response = await this.callOpenAI(goal, apiKey || providerConfig?.api_key_encrypted);
            } else if (provider === 'anthropic') {
                response = await this.callAnthropic(goal, apiKey || providerConfig?.api_key_encrypted);
            } else {
                throw new Error('Unsupported AI provider');
            }

            // Send AI response
            socket.emit('agent_response', {
                type: 'log',
                level: 'ai',
                message: response
            });

            // Save conversation
            await supabase.from('ai_agent_conversations').insert([{
                session_id: sessionId,
                room_code: roomCode,
                user_id: room.userId,
                role: 'user',
                message: goal,
                ai_provider: provider || 'openai'
            }]);

            await supabase.from('ai_agent_conversations').insert([{
                session_id: sessionId,
                room_code: roomCode,
                user_id: room.userId,
                role: 'assistant',
                message: response,
                ai_provider: provider || 'openai'
            }]);

            // Update session
            await supabase
                .from('ai_agent_sessions')
                .update({
                    status: 'completed',
                    completed_at: new Date().toISOString()
                })
                .eq('id', sessionId);

            // Send completion
            socket.emit('action_result', {
                success: true,
                message: 'Task completed successfully'
            });

        } catch (error) {
            console.error('Error processing AI request:', error);
            
            socket.emit('agent_response', {
                type: 'log',
                level: 'error',
                message: 'Error: ' + error.message
            });

            socket.emit('action_result', {
                success: false,
                message: 'Task failed: ' + error.message
            });

            // Update session as failed
            if (sessionId) {
                await supabase
                    .from('ai_agent_sessions')
                    .update({
                        status: 'failed',
                        error_message: error.message,
                        completed_at: new Date().toISOString()
                    })
                    .eq('id', sessionId);
            }
        }
    }

    async callOpenAI(prompt, apiKey) {
        if (!apiKey) {
            throw new Error('OpenAI API key not configured');
        }

        const openai = new OpenAI({ apiKey });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful AI assistant. Provide clear, concise, and helpful responses.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 1500,
            temperature: 0.7
        });

        return completion.choices[0].message.content;
    }

    async callAnthropic(prompt, apiKey) {
        if (!apiKey) {
            throw new Error('Anthropic API key not configured');
        }

        // TODO: Implement Anthropic API call
        throw new Error('Anthropic support coming soon');
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }
}

module.exports = AIAgentService;

