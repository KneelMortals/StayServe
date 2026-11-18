import 'room_model.dart';
import 'room_private_location.dart';

/// A room listing as seen by its owner.
///
/// The public [RoomModel] never contains the exact address. The owner-only
/// view joins it with the matching `roomPrivate/{roomId}` document so the
/// edit form can still show and change the real visit address.
class OwnedRoomModel extends RoomModel {
  final RoomPrivateLocation? privateLocation;

  OwnedRoomModel({required RoomModel listing, required this.privateLocation})
    : super(
        roomId: listing.roomId,
        ownerId: listing.ownerId,
        title: listing.title,
        description: listing.description,
        monthlyRent: listing.monthlyRent,
        securityDeposit: listing.securityDeposit,
        location: listing.location,
        roomType: listing.roomType,
        furnishing: listing.furnishing,
        availableFrom: listing.availableFrom,
        amenities: listing.amenities,
        occupancy: listing.occupancy,
        currentOccupancy: listing.currentOccupancy,
        genderPreference: listing.genderPreference,
        images: listing.images,
        status: listing.status,
        createdAt: listing.createdAt,
        updatedAt: listing.updatedAt,
        latitude: listing.latitude,
        longitude: listing.longitude,
        homeId: listing.homeId,
        homeName: listing.homeName,
      );
}
