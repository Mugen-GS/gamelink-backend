
export enum Sender {
  User = 'user',
  AI = 'ai',
  Admin = 'admin',
  System = 'system',
}

export interface Message {
  id: string;
  text: string;
  timestamp: number;
  sender: Sender;
}

export interface Contact {
  id:string;
  name: string;
  phone: string;
  avatarUrl: string;
  favoriteGames: string;
  school: string;
  location: string;
  budget: string;
  notes: string;
  chatHistory: Message[];
  lastMessageTime: number;
  aiAutoReply: boolean;
  needsFollowUp: boolean;
}

export interface Settings {
  whatsApp: {
    apiUrl: string;
  };
  aiTraining: {
    writingStyle: string;
    businessDescription: string;
    rules: string;
  };
  followUpHours: number;
  theme: string;
}