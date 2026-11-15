import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../firebase/owner/owner_repository.dart';
import '../providers/owner_providers.dart';
import '../widgets/room_form.dart';

class CreateRoomScreen extends ConsumerWidget {
  /// The home the new room belongs to.
  ///
  /// It is filled in when the owner taps "Add another room here" on one of
  /// the homes in the "My Rooms" screen.
  final String? initialHomeId;

  const CreateRoomScreen({this.initialHomeId, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The homes the owner already has — the new room can be added to one
    // of them, so several rooms of the same house can be published.
    final homes = ref.watch(ownerHomesProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Create Room Listing')),
      body: RoomForm(
        submitLabel: 'Create Listing',
        homes: homes,
        initialHomeId: initialHomeId,
        onSubmit: (draft) async {
          await ref.read(ownerRepositoryProvider).createRoom(draft);
          ref.invalidate(myRoomsProvider);
        },
      ),
    );
  }
}
