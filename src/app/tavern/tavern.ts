import { Component } from '@angular/core';
import { Scene } from '../scene/scene';
import { Chat } from '../chat/chat';

/** The live 3D room: scene + chat overlay. Reached only via tavernGuard after joining. */
@Component({
  selector: 'app-tavern',
  imports: [Scene, Chat],
  templateUrl: './tavern.html',
  styleUrl: './tavern.scss',
  standalone: true,
})
export class Tavern {}
